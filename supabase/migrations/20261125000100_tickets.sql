-- Support tickets (PLAN.md step 2.4). A customer's question or complaint, and where it stands. Only the runtime (the service key)
-- touches this table; a pod's agents never see it. Tickets are added by hand, by a script, or later by a Gmail reader.
--
-- The rules below are triggers and constraints, so they hold for everyone, including the runtime and the table owner, whatever
-- the application code does:
--   - what the customer wrote (address, subject, message) is fixed when the row is written: nobody can edit it afterwards
--   - one customer address, a one-line subject and a sensible size
--   - a ticket is `answered` only with the reply message it was answered with, and `escalated` only with the founder's decision
--     it was escalated on; once set, those links cannot be changed
--   - its life only moves forward, and nothing is ever deleted
-- Statuses: open -> in_progress | closed; in_progress -> open | answered | escalated; answered -> closed; escalated -> closed.
-- closed is final. in_progress means a team has taken the ticket, so two runs cannot answer it twice.

create table public.tickets (
  id               uuid primary key default gen_random_uuid(),
  customer_email   text not null
    constraint tickets_one_customer check (char_length(customer_email) <= 254 and customer_email ~ '^[^@[:space:],;<>"]+@[^@[:space:],;<>"]+\.[^@[:space:],;<>"]+$'),
  customer_name    text constraint tickets_name_size check (customer_name is null or char_length(customer_name) between 1 and 200),
  subject          text not null
    constraint tickets_one_line_subject check (char_length(subject) between 1 and 300 and subject !~ '[\r\n]'),
  body             text not null
    constraint tickets_body_size check (char_length(body) between 1 and 20000),
  status           text not null default 'open' check (status in ('open', 'in_progress', 'answered', 'escalated', 'closed')),
  reply_message_id uuid references public.outbound_messages (id) on delete restrict,
  decision_id      uuid references public.decisions (id) on delete restrict,
  note             text constraint tickets_note_size check (note is null or char_length(note) <= 1000),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint tickets_answered_has_reply check (status <> 'answered' or reply_message_id is not null),
  constraint tickets_escalated_has_decision check (status <> 'escalated' or decision_id is not null)
);
create index tickets_status_idx on public.tickets (status, created_at);

alter table public.tickets enable row level security;  -- no policy and no grant: pods never see it
revoke all on public.tickets from anon, authenticated;
grant all on public.tickets to service_role;

-- On insert: a ticket always starts open, with no reply and no decision.
create function private.tickets_before_insert() returns trigger
language plpgsql as $$
begin
  if new.status <> 'open' or new.reply_message_id is not null or new.decision_id is not null then
    raise exception 'a ticket starts open, with no reply and no decision'
      using errcode = 'restrict_violation';
  end if;
  new.created_at := now();
  new.updated_at := now();
  return new;
end;
$$;

create trigger tickets_set_defaults
  before insert on public.tickets
  for each row execute function private.tickets_before_insert();

-- On update: the customer's words are fixed, the links are fixed once set, and the status only moves forward.
create function private.guard_ticket_update() returns trigger
language plpgsql as $$
begin
  if new.id is distinct from old.id
     or new.customer_email is distinct from old.customer_email
     or new.customer_name is distinct from old.customer_name
     or new.subject is distinct from old.subject
     or new.body is distinct from old.body
     or new.created_at is distinct from old.created_at then
    raise exception 'what the customer wrote cannot be changed (ticket %)', old.id
      using errcode = 'restrict_violation';
  end if;

  if (old.reply_message_id is not null and new.reply_message_id is distinct from old.reply_message_id)
     or (old.decision_id is not null and new.decision_id is distinct from old.decision_id) then
    raise exception 'the reply and the decision of ticket % cannot be changed once set', old.id
      using errcode = 'restrict_violation';
  end if;

  if new.status is distinct from old.status then
    if not ((old.status = 'open' and new.status in ('in_progress', 'closed'))
            or (old.status = 'in_progress' and new.status in ('open', 'answered', 'escalated'))
            or (old.status in ('answered', 'escalated') and new.status = 'closed')) then
      raise exception 'ticket % cannot go from % to %', old.id, old.status, new.status
        using errcode = 'restrict_violation';
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger tickets_guard_update
  before update on public.tickets
  for each row execute function private.guard_ticket_update();

-- Tickets are history. Close one instead of deleting it.
create function private.reject_ticket_delete() returns trigger
language plpgsql as $$
begin
  raise exception 'tickets are never deleted; close ticket % instead', old.id
    using errcode = 'restrict_violation';
end;
$$;

create trigger tickets_never_deleted
  before delete on public.tickets
  for each row execute function private.reject_ticket_delete();
