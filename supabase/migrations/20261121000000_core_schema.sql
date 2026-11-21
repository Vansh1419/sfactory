-- sfactory core schema (PLAN.md step 1.1).
-- Tables only. Access rules are in 20261121000100_row_level_security.sql and the
-- integrity rules (append-only log, frozen decisions) in 20261121000200_integrity_rules.sql.
--
-- Conventions:
--   * pod_id is NULL for company-level rows (no project); pods always carry their own pod_id.
--   * Enumerations are text with CHECK constraints, which are easier to change than enum types.
--   * Times are timestamptz.

create extension if not exists vector with schema extensions;

-- Helper schema: functions here are not exposed through the Supabase API.
create schema if not exists private;

create function private.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- clients and projects
-- ---------------------------------------------------------------------------

create table public.clients (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  email      text,
  country    text,
  status     text not null default 'lead' check (status in ('lead', 'active', 'past')),
  notes      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.projects (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid references public.clients (id) on delete restrict,
  name       text not null,
  kind       text not null check (kind in ('agency_client', 'saas_product')),
  service    text check (service in ('web_development', 'ai_automation', 'marketing', 'content')),
  priority   text not null default 'P2' check (priority in ('P1', 'P2', 'P3')),
  deadline   timestamptz,
  status     text not null default 'planned' check (status in ('planned', 'active', 'paused', 'completed', 'cancelled')),
  repo_path  text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint projects_service_only_for_agency check (kind = 'agency_client' or service is null)
);
create index projects_client_id_idx on public.projects (client_id);

-- ---------------------------------------------------------------------------
-- pods: one per project, created from a template
-- ---------------------------------------------------------------------------

create table public.pods (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null unique references public.projects (id) on delete restrict,
  template   text not null check (template in ('agency_client', 'saas_product')),
  status     text not null default 'open' check (status in ('open', 'closed')),
  opened_at  timestamptz not null default now(),
  closed_at  timestamptz,
  constraint pods_closed_at_matches_status check ((status = 'closed') = (closed_at is not null))
);

-- ---------------------------------------------------------------------------
-- agents and pod membership
-- ---------------------------------------------------------------------------

create table public.agents (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  team       text not null check (team in ('orchestrator', 'product_engineering', 'marketing_sales', 'support', 'finance_legal_ops')),
  role       text not null check (role in ('orchestrator', 'team_lead', 'worker', 'specialist')),
  is_shared  boolean not null default false,  -- shared specialists serve every pod
  status     text not null default 'idle' check (status in ('idle', 'working', 'waiting', 'blocked', 'paused', 'removed')),
  model_tier text not null default 'cheap' check (model_tier in ('cheap', 'strong')),
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  constraint agents_removed_at_matches_status check ((status = 'removed') = (removed_at is not null))
);

create table public.pod_members (
  pod_id    uuid not null references public.pods (id) on delete cascade,
  agent_id  uuid not null references public.agents (id) on delete cascade,
  joined_at timestamptz not null default now(),
  left_at   timestamptz,
  primary key (pod_id, agent_id)
);
create index pod_members_agent_id_idx on public.pod_members (agent_id);

-- ---------------------------------------------------------------------------
-- tasks
-- ---------------------------------------------------------------------------

create table public.tasks (
  id                  uuid primary key default gen_random_uuid(),
  pod_id              uuid references public.pods (id) on delete cascade,
  parent_task_id      uuid references public.tasks (id) on delete cascade,
  team                text not null check (team in ('orchestrator', 'product_engineering', 'marketing_sales', 'support', 'finance_legal_ops')),
  title               text not null,
  description         text,
  status              text not null default 'queued' check (status in ('queued', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled')),
  priority            text not null default 'P2' check (priority in ('P1', 'P2', 'P3')),
  assigned_agent_id   uuid references public.agents (id) on delete set null,
  created_by_agent_id uuid references public.agents (id) on delete set null,
  blocked_reason      text,
  queued_at           timestamptz not null default now(),
  started_at          timestamptz,
  completed_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint tasks_blocked_needs_reason check (status <> 'blocked' or blocked_reason is not null)
);
create index tasks_pod_status_idx on public.tasks (pod_id, status);
create index tasks_team_status_idx on public.tasks (team, status);
create index tasks_assigned_agent_idx on public.tasks (assigned_agent_id);

-- ---------------------------------------------------------------------------
-- decisions: the founder's approval queue
-- ---------------------------------------------------------------------------

create table public.decisions (
  id                    uuid primary key default gen_random_uuid(),
  pod_id                uuid references public.pods (id) on delete restrict,
  task_id               uuid references public.tasks (id) on delete set null,
  requested_by_agent_id uuid references public.agents (id) on delete set null,
  category              text not null check (category in ('spend', 'people_or_contracts', 'launch_or_pricing', 'legal_or_public', 'unknown')),
  action                jsonb not null,  -- what the policy check saw: { tool, access, args }
  card                  jsonb not null,  -- the plain-language card the founder reads
  amount_inr            numeric(14, 2) check (amount_inr is null or amount_inr >= 0),
  amount_usd            numeric(14, 2) check (amount_usd is null or amount_usd >= 0),
  status                text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'info_requested', 'cancelled')),
  resolved_via          text check (resolved_via in ('dashboard', 'telegram')),
  resolved_at           timestamptz,
  resolution_note       text,
  deadline_at           timestamptz,
  reminder_count        integer not null default 0 check (reminder_count >= 0),
  last_reminded_at      timestamptz,
  created_at            timestamptz not null default now(),
  constraint decisions_card_has_all_seven_fields
    check (card ?& array['decide', 'why_now', 'if_yes', 'if_no', 'cost', 'risk', 'recommendation']),
  constraint decisions_resolution_recorded
    check (status not in ('approved', 'rejected') or (resolved_at is not null and resolved_via is not null))
);
create index decisions_pending_idx on public.decisions (created_at) where status = 'pending';
create index decisions_pod_id_idx on public.decisions (pod_id);

-- ---------------------------------------------------------------------------
-- audit_log: every agent and founder action (append-only, enforced in the next migration)
-- ---------------------------------------------------------------------------

create table public.audit_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  actor_type  text not null check (actor_type in ('agent', 'founder', 'system')),
  actor_id    uuid,  -- an agent id when actor_type = 'agent'; not a foreign key, agents can be removed
  pod_id      uuid references public.pods (id) on delete restrict,
  action      text not null,
  target_type text,
  target_id   uuid,
  detail      jsonb not null default '{}'
);
create index audit_log_pod_at_idx on public.audit_log (pod_id, at desc);
create index audit_log_at_idx on public.audit_log (at desc);

-- ---------------------------------------------------------------------------
-- memory: agent memory, searchable by meaning
-- ---------------------------------------------------------------------------

create table public.memory (
  id         uuid primary key default gen_random_uuid(),
  pod_id     uuid references public.pods (id) on delete cascade,
  agent_id   uuid references public.agents (id) on delete set null,
  kind       text not null check (kind in ('fact', 'note', 'summary', 'lesson')),
  content    text not null,
  metadata   jsonb not null default '{}',
  -- 768 dimensions fits common local embedding models (for example nomic-embed-text).
  -- Changing the model later means a migration, so decide before real data goes in.
  embedding  extensions.vector(768),
  created_at timestamptz not null default now()
);
create index memory_pod_id_idx on public.memory (pod_id);
create index memory_embedding_idx on public.memory using hnsw (embedding extensions.vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- agent_events: every step an agent takes, for the live feed
-- ---------------------------------------------------------------------------

create table public.agent_events (
  id       bigint generated always as identity primary key,
  at       timestamptz not null default now(),
  pod_id   uuid references public.pods (id) on delete cascade,
  agent_id uuid references public.agents (id) on delete set null,
  task_id  uuid references public.tasks (id) on delete set null,
  kind     text not null check (kind in ('file_read', 'file_written', 'tool_used', 'test_run', 'help_asked', 'message', 'status_change', 'error')),
  summary  text not null,
  detail   jsonb not null default '{}'
);
create index agent_events_pod_at_idx on public.agent_events (pod_id, at desc);
create index agent_events_agent_at_idx on public.agent_events (agent_id, at desc);

-- ---------------------------------------------------------------------------
-- scaling_rules: when to add or remove agents, and the caps the founder sets
-- ---------------------------------------------------------------------------

create table public.scaling_rules (
  id                          uuid primary key default gen_random_uuid(),
  scope                       text not null check (scope in ('global', 'pod')),
  team                        text check (team in ('orchestrator', 'product_engineering', 'marketing_sales', 'support', 'finance_legal_ops')),
  role                        text check (role in ('orchestrator', 'team_lead', 'worker', 'specialist')),
  max_agents                  integer not null check (max_agents >= 0),
  scale_up_queue_threshold    integer check (scale_up_queue_threshold > 0),
  scale_up_wait_minutes       integer check (scale_up_wait_minutes > 0),
  idle_minutes_before_removal integer check (idle_minutes_before_removal > 0),
  enabled                     boolean not null default true,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------

create trigger clients_set_updated_at before update on public.clients
  for each row execute function private.set_updated_at();
create trigger projects_set_updated_at before update on public.projects
  for each row execute function private.set_updated_at();
create trigger tasks_set_updated_at before update on public.tasks
  for each row execute function private.set_updated_at();
create trigger scaling_rules_set_updated_at before update on public.scaling_rules
  for each row execute function private.set_updated_at();
