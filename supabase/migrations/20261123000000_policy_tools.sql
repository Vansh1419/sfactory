-- Tools the founder adds to the policy check from Telegram (decided Nov 23, 2026,
-- after PLAN.md step 1.6).
--
-- The policy check's built-in rules stay in code (src/runtime/policy.js) and cannot be
-- changed from a phone. This table holds the founder's additions, which the runtime
-- merges in; a built-in rule always wins over a row here (checked in code, and by the
-- `policy-tools` eval).
--
--   kind 'ask'      the tool always needs the founder, in one of the four categories.
--                   Safe, so it is active as soon as it is added.
--   kind 'routine'  the tool runs without asking when it carries the given read or
--                   write tag. This LOOSENS the rules, so it starts as 'proposed' and
--                   only counts once the founder confirms it.
--
-- Rules are never edited: to change one, remove it and propose a new one. Removing is
-- final and immediate. Only the runtime (service_role) can see or touch this table; a
-- pod agent, or anyone without the service key, cannot.

create table public.policy_tools (
  id            uuid primary key default gen_random_uuid(),
  tool          text not null
    constraint policy_tools_name_shape check (tool ~ '^[a-z0-9_-]+(\.[a-z0-9_-]+)+$' and char_length(tool) between 3 and 200),
  kind          text not null check (kind in ('ask', 'routine')),
  category      text check (category in ('spend', 'people_or_contracts', 'launch_or_pricing', 'legal_or_public')),
  access        text check (access in ('read', 'write')),
  status        text not null default 'proposed' check (status in ('proposed', 'active', 'removed')),
  proposed_via  text not null check (proposed_via in ('dashboard', 'telegram')),
  confirmed_via text check (confirmed_via in ('dashboard', 'telegram')),
  note          text,
  created_at    timestamptz not null default now(),
  activated_at  timestamptz,
  removed_at    timestamptz,
  constraint policy_tools_rule_shape check (
    (kind = 'ask' and category is not null and access is null)
    or (kind = 'routine' and access is not null and category is null)
  ),
  constraint policy_tools_active_recorded check (status <> 'active' or (activated_at is not null and confirmed_via is not null)),
  constraint policy_tools_removed_recorded check (status <> 'removed' or removed_at is not null)
);

-- A tool has at most one live rule; a removed one can be proposed again.
create unique index policy_tools_one_live_rule_per_tool on public.policy_tools (tool) where status in ('proposed', 'active');
create index policy_tools_active_idx on public.policy_tools (tool) where status = 'active';

alter table public.policy_tools enable row level security;  -- no policy and no grant: pods never see it
revoke all on public.policy_tools from anon, authenticated;
grant all on public.policy_tools to service_role;

-- A rule is fixed once it exists, and its life only moves forward: proposed -> active ->
-- removed, or proposed -> removed. These hold for everyone, including the runtime.
create function private.guard_policy_tool_update() returns trigger
language plpgsql as $$
begin
  if old.status = 'removed' then
    raise exception 'policy rule % is removed and cannot change; propose the tool again instead', old.id
      using errcode = 'restrict_violation';
  end if;

  if new.tool is distinct from old.tool
     or new.kind is distinct from old.kind
     or new.category is distinct from old.category
     or new.access is distinct from old.access
     or new.proposed_via is distinct from old.proposed_via
     or new.created_at is distinct from old.created_at then
    raise exception 'policy rule % cannot be edited; remove it and propose a new one', old.id
      using errcode = 'restrict_violation';
  end if;

  if new.status is distinct from old.status
     and not ((old.status = 'proposed' and new.status in ('active', 'removed'))
              or (old.status = 'active' and new.status = 'removed')) then
    raise exception 'policy rule % cannot go from % to %', old.id, old.status, new.status
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$$;

create trigger policy_tools_guard_update
  before update on public.policy_tools
  for each row execute function private.guard_policy_tool_update();

-- Rules are history. Remove one instead of deleting it.
create function private.reject_policy_tool_delete() returns trigger
language plpgsql as $$
begin
  raise exception 'policy rules are never deleted; remove rule % instead', old.id
    using errcode = 'restrict_violation';
end;
$$;

create trigger policy_tools_never_deleted
  before delete on public.policy_tools
  for each row execute function private.reject_policy_tool_delete();
