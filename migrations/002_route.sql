-- M2-P1. 001 не меняется: новая таблица и колонка стоимости.

create table route_rules (
  id uuid primary key,
  tenant_id text not null,
  agent_id uuid not null references agents (id) on delete cascade,
  kind text not null check (kind in ('write_tool', 'second_parse_error')),
  model_alias text not null,
  provider text not null check (provider = 'external')
);

-- Число из ответа внешней модели либо null. Локальный ход пишет 0 из раннера.
alter table run_steps add column cost_usd numeric;
