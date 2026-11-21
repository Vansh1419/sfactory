-- Access rules (PLAN.md step 1.1): a pod can only read its own rows.
--
-- Who connects how:
--   * The runtime uses the service_role key. It bypasses row-level security (RLS) and
--     is trusted. The renderer never touches the database.
--   * A pod-scoped client (an agent limited to one pod, see PLAN.md step 3.2) connects
--     as the `authenticated` role with a JWT that carries a `pod_id` claim. Every policy
--     below is keyed on that claim, so a missing or wrong claim sees nothing.
--   * `anon` gets nothing at all.
--
-- Pod agents can read their own pod's rows, file their own tasks, events, memory and
-- requests, and nothing else. They cannot approve decisions, delete anything, write
-- the audit log, or see scaling rules.

grant usage on schema private to authenticated;

-- The pod this request is scoped to, or NULL.
create function private.current_pod_id() returns uuid
language sql stable as $$
  select nullif(auth.jwt() ->> 'pod_id', '')::uuid
$$;

-- Supabase grants new tables to the API roles by default. Take that back, then grant only what is needed.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

alter table public.clients       enable row level security;
alter table public.projects      enable row level security;
alter table public.pods          enable row level security;
alter table public.agents        enable row level security;
alter table public.pod_members   enable row level security;
alter table public.tasks         enable row level security;
alter table public.decisions     enable row level security;
alter table public.audit_log     enable row level security;
alter table public.memory        enable row level security;
alter table public.agent_events  enable row level security;
alter table public.scaling_rules enable row level security;  -- no policy and no grant: pods never see it

grant select on public.pods, public.pod_members, public.projects, public.clients, public.agents, public.audit_log to authenticated;
grant select, insert, update on public.tasks, public.memory to authenticated;
grant select, insert on public.decisions, public.agent_events to authenticated;

-- (select ...) lets Postgres evaluate the claim once per query instead of once per row.

create policy pods_read_own on public.pods
  for select to authenticated
  using (id = (select private.current_pod_id()));

create policy pod_members_read_own on public.pod_members
  for select to authenticated
  using (pod_id = (select private.current_pod_id()));

create policy projects_read_own on public.projects
  for select to authenticated
  using (exists (
    select 1 from public.pods p
    where p.project_id = projects.id and p.id = (select private.current_pod_id())
  ));

-- A pod sees the client of its own project, never other clients or leads.
create policy clients_read_own on public.clients
  for select to authenticated
  using (exists (
    select 1 from public.projects pr
    join public.pods p on p.project_id = pr.id
    where pr.client_id = clients.id and p.id = (select private.current_pod_id())
  ));

-- A pod sees the agents in its own pod and the shared specialists. A request with
-- no pod claim sees none of them: the claim is checked first.
create policy agents_read_own_or_shared on public.agents
  for select to authenticated
  using (
    (select private.current_pod_id()) is not null
    and (
      is_shared
      or exists (
        select 1 from public.pod_members m
        where m.agent_id = agents.id and m.pod_id = (select private.current_pod_id()) and m.left_at is null
      )
    )
  );

create policy tasks_read_own on public.tasks
  for select to authenticated
  using (pod_id = (select private.current_pod_id()));
create policy tasks_insert_own on public.tasks
  for insert to authenticated
  with check (pod_id = (select private.current_pod_id()));
create policy tasks_update_own on public.tasks
  for update to authenticated
  using (pod_id = (select private.current_pod_id()))
  with check (pod_id = (select private.current_pod_id()));

create policy decisions_read_own on public.decisions
  for select to authenticated
  using (pod_id = (select private.current_pod_id()));
-- A pod can only file a request as pending. It has no update grant, so it can never approve its own request.
create policy decisions_insert_own_pending on public.decisions
  for insert to authenticated
  with check (
    pod_id = (select private.current_pod_id())
    and status = 'pending' and resolved_at is null and resolved_via is null
  );

create policy agent_events_read_own on public.agent_events
  for select to authenticated
  using (pod_id = (select private.current_pod_id()));
create policy agent_events_insert_own on public.agent_events
  for insert to authenticated
  with check (pod_id = (select private.current_pod_id()));

create policy memory_read_own on public.memory
  for select to authenticated
  using (pod_id = (select private.current_pod_id()));
create policy memory_insert_own on public.memory
  for insert to authenticated
  with check (pod_id = (select private.current_pod_id()));
create policy memory_update_own on public.memory
  for update to authenticated
  using (pod_id = (select private.current_pod_id()))
  with check (pod_id = (select private.current_pod_id()));

create policy audit_log_read_own on public.audit_log
  for select to authenticated
  using (pod_id = (select private.current_pod_id()));
