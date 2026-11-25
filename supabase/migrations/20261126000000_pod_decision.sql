-- Pods are opened by the founder's decision (PLAN.md step 3.1). A pod is one project's own folder, git repo, memory and members, so opening one is
-- a commitment: the founder approves a card first. These rules are triggers and constraints, so they hold for everyone, including the runtime and
-- the table owner, whatever the application code does:
--   - a pod that names a decision can only be opened on an APPROVED decision of its own kind (the action tool is `pod.create`), and one decision
--     opens at most one pod (so answering twice, or two runs at once, cannot make two pods)
--   - what a pod was opened for (its project, its template, its decision, when) cannot be changed afterwards
--   - a pod's life only moves forward: open -> closed, and a closed pod stays closed
-- decision_id may be empty for a pod made without a card (the dev seed and the isolation tests do that); the runtime always sets it.

-- No foreign key: decisions are never deleted (a trigger refuses it), and the insert trigger below checks that the decision exists, so a key would only
-- stop the evals that empty `decisions` between cases from running.
alter table public.pods add column decision_id uuid unique;

create function private.pods_guard_insert() returns trigger
language plpgsql as $$
begin
  if new.decision_id is not null
     and not exists (select 1 from public.decisions d where d.id = new.decision_id and d.status = 'approved' and d.action ->> 'tool' = 'pod.create') then
    raise exception 'a pod can only be opened on an approved pod.create decision (decision %)', new.decision_id
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

create trigger pods_guard_insert
  before insert on public.pods
  for each row execute function private.pods_guard_insert();

create function private.pods_guard_update() returns trigger
language plpgsql as $$
begin
  if new.id is distinct from old.id
     or new.project_id is distinct from old.project_id
     or new.template is distinct from old.template
     or new.decision_id is distinct from old.decision_id
     or new.opened_at is distinct from old.opened_at then
    raise exception 'what pod % was opened for cannot be changed', old.id
      using errcode = 'restrict_violation';
  end if;
  if old.status = 'closed' and new.status is distinct from 'closed' then
    raise exception 'pod % is closed and stays closed', old.id
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

create trigger pods_guard_update
  before update on public.pods
  for each row execute function private.pods_guard_update();
