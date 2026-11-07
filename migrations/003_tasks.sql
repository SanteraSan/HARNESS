-- M2-P3. 001 не меняется.
-- Задача принадлежит запуску менеджера. approve переводит только status.
-- Дочерняя работа — строка runs с parent_run_id, её забирает тот же воркер.

create table tasks (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  agent_id uuid not null references agents (id) on delete cascade,
  run_id uuid not null references runs (id) on delete cascade,
  status text not null check (status in ('open', 'approved')),
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  unique (run_id)
);
