-- Outbound client messages (PLAN.md step 2.2). Every message the company sends to a client is written here first, reviewed
-- by the review agent, and, while the founder's approval is required, approved by the founder on a decision card. Only
-- the runtime (the service key) touches this table; a pod's agents never see it.
--
-- The rules below are triggers and constraints, so they hold for everyone, including the runtime and the table owner,
-- whatever the application code does:
--   - the content (recipient, subject, body) is fixed when the row is written, and the database computes its hash
--   - a message becomes `ready` only with a PASSING review and, when the founder's approval is required (the setting, or
--     a review that says it must go to the founder), an APPROVED decision; it is `sent` only after `sending`; its life only
--     moves forward
--   - one recipient, a one-line subject and a sensible size, so a header cannot be injected through any of them
-- Statuses: drafted -> review_failed | awaiting_founder | ready | cancelled; review_failed -> cancelled;
-- awaiting_founder -> ready | rejected | cancelled; ready -> sending | cancelled; sending -> sent | send_failed.
-- rejected, sent, send_failed and cancelled are final.

create table public.outbound_messages (
  id                        uuid primary key default gen_random_uuid(),
  team                      text not null check (team in ('orchestrator', 'product_engineering', 'marketing_sales', 'support', 'finance_legal_ops')),
  created_by_agent_id       uuid references public.agents (id) on delete set null,
  kind                      text not null default 'email' check (kind in ('email')),
  to_address                text not null
    constraint outbound_one_recipient check (char_length(to_address) <= 254 and to_address ~ '^[^@[:space:],;<>"]+@[^@[:space:],;<>"]+\.[^@[:space:],;<>"]+$'),
  subject                   text not null
    constraint outbound_one_line_subject check (char_length(subject) between 1 and 300 and subject !~ '[\r\n]'),
  body                      text not null
    constraint outbound_body_size check (char_length(body) between 1 and 20000),
  content_hash              text not null,
  status                    text not null default 'drafted' check (status in ('drafted', 'review_failed', 'awaiting_founder', 'ready', 'rejected', 'sending', 'sent', 'send_failed', 'cancelled')),
  review                    jsonb,  -- the review agent's verdict: { verdict: 'pass' | 'fail' | 'escalate', problems: [...] }
  decision_id               uuid references public.decisions (id) on delete restrict,
  founder_approval_required boolean not null default true,
  reviewed_at               timestamptz,
  sent_at                   timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  constraint outbound_awaiting_has_decision check (status <> 'awaiting_founder' or decision_id is not null),
  constraint outbound_sent_recorded check (status <> 'sent' or sent_at is not null)
);
create index outbound_messages_status_idx on public.outbound_messages (status);
create index outbound_messages_decision_idx on public.outbound_messages (decision_id) where decision_id is not null;

alter table public.outbound_messages enable row level security;  -- no policy and no grant: pods never see it
revoke all on public.outbound_messages from anon, authenticated;
grant all on public.outbound_messages to service_role;

-- On insert: the database computes the hash (nobody can write a different one), and a message always starts as a draft.
create function private.outbound_before_insert() returns trigger
language plpgsql as $$
begin
  if new.status <> 'drafted' then
    raise exception 'an outbound message starts as a draft, not as %', new.status
      using errcode = 'restrict_violation';
  end if;
  -- (written inline: the runtime's role has no access to helper functions in the private schema)
  new.content_hash := encode(sha256(convert_to(new.to_address || E'\n' || new.subject || E'\n' || new.body, 'UTF8')), 'hex');
  new.created_at := now();
  new.updated_at := now();
  return new;
end;
$$;

create trigger outbound_messages_before_insert
  before insert on public.outbound_messages
  for each row execute function private.outbound_before_insert();

create function private.guard_outbound_update() returns trigger
language plpgsql as $$
begin
  if old.status in ('rejected', 'sent', 'send_failed', 'cancelled') then
    raise exception 'outbound message % is % and cannot change', old.id, old.status
      using errcode = 'restrict_violation';
  end if;

  -- What was reviewed and approved is exactly what is sent.
  if new.team is distinct from old.team
     or new.kind is distinct from old.kind
     or new.to_address is distinct from old.to_address
     or new.subject is distinct from old.subject
     or new.body is distinct from old.body
     or new.content_hash is distinct from old.content_hash
     or new.founder_approval_required is distinct from old.founder_approval_required
     or new.created_by_agent_id is distinct from old.created_by_agent_id then
    raise exception 'the content of outbound message % cannot change after it is written; write a new message', old.id
      using errcode = 'restrict_violation';
  end if;

  -- A verdict and a decision are recorded once.
  if old.review is not null and new.review is distinct from old.review then
    raise exception 'the review of outbound message % cannot change', old.id using errcode = 'restrict_violation';
  end if;
  if old.decision_id is not null and new.decision_id is distinct from old.decision_id then
    raise exception 'the decision of outbound message % cannot change', old.id using errcode = 'restrict_violation';
  end if;

  if new.status is distinct from old.status then
    if not ((old.status = 'drafted' and new.status in ('review_failed', 'awaiting_founder', 'ready', 'cancelled'))
            or (old.status = 'review_failed' and new.status = 'cancelled')
            or (old.status = 'awaiting_founder' and new.status in ('ready', 'rejected', 'cancelled'))
            or (old.status = 'ready' and new.status in ('sending', 'cancelled'))
            or (old.status = 'sending' and new.status in ('sent', 'send_failed'))) then
      raise exception 'outbound message % cannot go from % to %', old.id, old.status, new.status
        using errcode = 'restrict_violation';
    end if;

    -- A review passes only when it says so exactly. Anything else (no review, "PASS", true, a list) is not a pass.
    if new.status in ('awaiting_founder', 'ready') and not coalesce(jsonb_typeof(new.review) = 'object' and new.review ->> 'verdict' = 'pass', false) then
      raise exception 'outbound message % cannot be % without a passing review', old.id, new.status
        using errcode = 'restrict_violation';
    end if;

    -- The founder is needed when the setting says so, or when the review passed but said the message must go to the founder.
    if new.status = 'ready' and (new.founder_approval_required or coalesce(new.review ->> 'escalate' = 'true', false)) then
      if old.status = 'drafted' then
        raise exception 'outbound message % needs the founder before it can be ready', old.id
          using errcode = 'restrict_violation';
      end if;
      if not exists (select 1 from public.decisions d where d.id = new.decision_id and d.status = 'approved') then
        raise exception 'outbound message % has no approved decision', old.id
          using errcode = 'restrict_violation';
      end if;
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger outbound_messages_guard_update
  before update on public.outbound_messages
  for each row execute function private.guard_outbound_update();

-- Messages are history. Cancel one instead of deleting it.
create function private.reject_outbound_delete() returns trigger
language plpgsql as $$
begin
  raise exception 'outbound messages are never deleted; cancel message % instead', old.id
    using errcode = 'restrict_violation';
end;
$$;

create trigger outbound_messages_never_deleted
  before delete on public.outbound_messages
  for each row execute function private.reject_outbound_delete();
