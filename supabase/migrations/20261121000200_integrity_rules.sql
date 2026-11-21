-- Integrity rules (PLAN.md step 1.1). These hold for everyone, including the
-- runtime's service_role and the table owner, because they are triggers and not
-- permissions. They exist so that "nothing is approved twice" and "every action is
-- logged" do not depend on application code being correct.

-- ---------------------------------------------------------------------------
-- audit_log is append-only
-- ---------------------------------------------------------------------------

create function private.reject_change() returns trigger
language plpgsql as $$
begin
  raise exception '% on % is not allowed: the table is append-only', tg_op, tg_table_name
    using errcode = 'restrict_violation';
end;
$$;

create trigger audit_log_append_only_rows
  before update or delete on public.audit_log
  for each row execute function private.reject_change();

create trigger audit_log_append_only_truncate
  before truncate on public.audit_log
  for each statement execute function private.reject_change();

-- ---------------------------------------------------------------------------
-- decisions: what the founder approved cannot change afterwards
-- ---------------------------------------------------------------------------

create function private.guard_decision_update() returns trigger
language plpgsql as $$
begin
  -- Approved, rejected and cancelled are final. This is what stops a decision being
  -- approved twice, or flipped after the fact, from the dashboard and Telegram at once.
  if old.status in ('approved', 'rejected', 'cancelled') then
    raise exception 'decision % is already % and cannot change', old.id, old.status
      using errcode = 'restrict_violation';
  end if;

  -- The content the founder is shown is fixed when the request is filed.
  if new.pod_id is distinct from old.pod_id
     or new.category is distinct from old.category
     or new.action is distinct from old.action
     or new.card is distinct from old.card
     or new.amount_inr is distinct from old.amount_inr
     or new.amount_usd is distinct from old.amount_usd
     or new.requested_by_agent_id is distinct from old.requested_by_agent_id then
    raise exception 'the content of decision % cannot change after it is filed; cancel it and file a new one', old.id
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$$;

create trigger decisions_guard_update
  before update on public.decisions
  for each row execute function private.guard_decision_update();

-- Decisions are history. Cancel one instead of deleting it.
create function private.reject_decision_delete() returns trigger
language plpgsql as $$
begin
  raise exception 'decisions are never deleted; cancel decision % instead', old.id
    using errcode = 'restrict_violation';
end;
$$;

create trigger decisions_never_deleted
  before delete on public.decisions
  for each row execute function private.reject_decision_delete();
