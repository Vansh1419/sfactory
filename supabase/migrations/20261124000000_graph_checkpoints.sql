-- Where a paused orchestrator run is kept (PLAN.md step 1.7b, decided Nov 24, 2026).
--
-- LangGraph saves a "checkpoint" after every step of a run, and the run can stop and wait
-- for a founder decision for hours. Keeping the checkpoints in the database means a waiting
-- run survives the app closing, and the same code works in Electron and on a future headless
-- server (the ready-made SQLite store needs a native module that does not match Electron).
--
--   graph_checkpoints  one row per saved step of a run (a "thread"): the run's state
--   graph_writes       the results of tasks that finished inside a step, kept until the
--                      step completes, so a resumed run does not repeat finished work
--
-- The state and the results are serialized by LangGraph and stored as base64 text, so any
-- bytes survive. Checkpoints are only ever added (a new id per step); a row is replaced only
-- when LangGraph saves the same id again. Only the runtime (service_role) can see or touch
-- these tables: a pod agent, or anyone without the service key, cannot, because a run's state
-- can hold anything an agent was working on.

create table public.graph_checkpoints (
  thread_id            text not null check (char_length(thread_id) between 1 and 200),
  checkpoint_ns        text not null default '' check (char_length(checkpoint_ns) <= 200),
  checkpoint_id        text not null check (char_length(checkpoint_id) between 1 and 200),
  parent_checkpoint_id text check (parent_checkpoint_id is null or char_length(parent_checkpoint_id) between 1 and 200),
  type                 text check (type is null or char_length(type) <= 50),
  checkpoint           text not null,
  metadata             text not null,
  created_at           timestamptz not null default now(),
  primary key (thread_id, checkpoint_ns, checkpoint_id)
);

create table public.graph_writes (
  thread_id     text not null check (char_length(thread_id) between 1 and 200),
  checkpoint_ns text not null default '' check (char_length(checkpoint_ns) <= 200),
  checkpoint_id text not null check (char_length(checkpoint_id) between 1 and 200),
  task_id       text not null check (char_length(task_id) between 1 and 200),
  task_path     text not null default '' check (char_length(task_path) <= 1000),
  idx           integer not null,
  channel       text not null check (char_length(channel) between 1 and 200),
  type          text check (type is null or char_length(type) <= 50),
  value         text not null,
  created_at    timestamptz not null default now(),
  primary key (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
);

alter table public.graph_checkpoints enable row level security;  -- no policy and no grant: pods never see it
alter table public.graph_writes enable row level security;
revoke all on public.graph_checkpoints, public.graph_writes from anon, authenticated;
grant all on public.graph_checkpoints, public.graph_writes to service_role;
