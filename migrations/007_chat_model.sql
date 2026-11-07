-- M3-P6. 001 не меняется.
-- Выбор модели одного чата Telegram. Повтор команды обновляет ту же строку.
-- API, cron и delegation эту таблицу не читают. chat_id остаётся bigint.

create table chat_model_choices (
  tenant_id text not null,
  chat_id bigint not null,
  model_alias text not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, chat_id),
  constraint chat_model_choices_alias check (model_alias in ('agent', 'coder-cloud'))
);
