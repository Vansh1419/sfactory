-- The runtime's own settings (PLAN.md step 4.2, "Guardrails"; the Settings page of step 4.3 edits the same rows).
--
-- One row per named group of settings, each a small JSON object:
--   key 'guardrails'   { "maxTasksPerDay": 40, "loopRepeats": 3, "stoppedTeams": ["support"] }
-- The runtime reads them live (a change takes effect within a few seconds, without a restart), and checks every value in code before it uses it,
-- so a row that was edited by hand with a nonsense value is ignored and the default is used. A team named in `stoppedTeams` is switched off: its agents
-- stop at their next step and it takes no new task until it is switched on again.
--
-- Only the runtime (service_role) can see or change this table; a pod agent, or anyone without the service key, cannot. Changes are made by the runtime
-- and are written to the audit log first.

create table public.app_settings (
  key        text primary key
    constraint app_settings_key_shape check (key ~ '^[a-z][a-z_]{0,59}$'),
  value      jsonb not null default '{}'
    constraint app_settings_value_is_an_object check (jsonb_typeof(value) = 'object'),
  updated_at timestamptz not null default now()
);

alter table public.app_settings enable row level security;  -- no policy and no grant: pods never see it
revoke all on public.app_settings from anon, authenticated;
grant all on public.app_settings to service_role;
