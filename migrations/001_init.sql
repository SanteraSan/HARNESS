create extension if not exists pgcrypto;

create table agents (
  id uuid primary key,
  tenant_id text not null default 'local',
  slug text not null,
  display_name text not null,
  system_prompt text not null,
  model_alias text not null,
  provider text not null default 'local' check (provider in ('local', 'external')),
  max_steps integer not null default 8 check (max_steps between 1 and 16),
  tool_allowlist text[] not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, slug)
);

create table runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  agent_id uuid not null references agents (id),
  parent_run_id uuid references runs (id),
  source text not null check (source in ('api', 'telegram', 'cron', 'delegation')),
  status text not null check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  priority integer not null default 100,
  deadline_at timestamptz,
  not_before timestamptz,
  chat_id bigint,
  payload jsonb not null,
  idempotency_key text not null,
  attempt integer not null default 0,
  max_attempts integer not null default 3,
  locked_by text,
  locked_until timestamptz,
  model_alias text,
  provider text,
  prompt_tokens integer,
  completion_tokens integer,
  error text,
  final_text text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  unique (agent_id, idempotency_key)
);

-- Частичный индекс захвата: предикат status = 'queued' совпадает с запросом, планировщик не читает историю.
create index runs_claim_idx on runs (priority, created_at)
  where status = 'queued';

create index runs_dialog_idx on runs (agent_id, chat_id)
  where status in ('queued', 'running') and chat_id is not null;

create table run_steps (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs (id),
  step_index integer not null check (step_index >= 0),
  kind text not null check (kind in (
    'model_request', 'tool_call', 'tool_result', 'policy_deny',
    'parse_error', 'final', 'lock_lost'
  )),
  tool_name text,
  request_excerpt text,
  response_excerpt text,
  prompt_tokens integer,
  completion_tokens integer,
  error text,
  created_at timestamptz not null default now(),
  unique (run_id, step_index)
);
