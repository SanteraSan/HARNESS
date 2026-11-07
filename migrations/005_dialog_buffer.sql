-- M2-P5. 001 не меняется.
-- Буфер занятого чата: Telegram хранит текст и ставит один запуск после финиша живого.
-- run_deliveries — отметка, что итог уже подготовлен. Новый процесс не готовит его снова.
-- chat_id остаётся bigint. Обе таблицы уходят каскадом вместе с runs и agents,
-- иначе очистка harness_test упрётся в FK.

create table dialog_buffer (
  id uuid primary key default gen_random_uuid(),
  buffer_seq bigserial not null,
  tenant_id text not null,
  agent_id uuid not null references agents (id) on delete cascade,
  chat_id bigint not null,
  idempotency_key text not null,
  message text not null,
  created_at timestamptz not null default now(),
  unique (agent_id, idempotency_key),
  constraint dialog_buffer_message_length check (char_length(message) between 1 and 8000),
  constraint dialog_buffer_key_length check (char_length(idempotency_key) between 1 and 200)
);

create index dialog_buffer_chat_idx on dialog_buffer (agent_id, chat_id, buffer_seq);

create table run_deliveries (
  run_id uuid primary key references runs (id) on delete cascade,
  prepared_at timestamptz not null default now()
);
