-- M2-P4. 001 не меняется.
-- script — процесс из allowlist, без модели. agent — строка runs с source = cron.
-- Пауза и текст для чата живут здесь: в Telegram эта миграция ничего не шлёт.
-- last_run_id и counted_failure_run_id снимаются при delete runs (хелпер теста),
-- agent_id каскадом уходит вместе с агентом. Иначе очистка harness_test упрётся в FK.

create table cron_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  agent_id uuid not null references agents (id) on delete cascade,
  kind text not null check (kind in ('script', 'agent')),
  schedule text not null check (char_length(schedule) between 1 and 100),
  paused boolean not null default false,
  pause_chat_id bigint not null,
  pause_message text,
  command text[],
  message text,
  consecutive_failures integer not null default 0 check (consecutive_failures between 0 and 1000),
  counted_failure_run_id uuid references runs (id) on delete set null,
  last_run_id uuid references runs (id) on delete set null,
  last_dispatched_at timestamptz,
  busy_until timestamptz,
  dispatch_token uuid,
  created_at timestamptz not null default now(),
  constraint cron_jobs_pause_message_length check (
    pause_message is null or char_length(pause_message) between 1 and 500
  ),
  constraint cron_jobs_kind_shape check (
    (
      kind = 'script'
      and command is not null
      and cardinality(command) between 1 and 8
      and message is null
    )
    or (
      kind = 'agent'
      and command is null
      and message is not null
      and char_length(message) between 1 and 8000
    )
  )
);
