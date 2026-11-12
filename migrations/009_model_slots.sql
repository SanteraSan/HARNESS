-- Право одного хода модели. Строки 1..N вставляет установка, не эта миграция.
-- 001 … 008 не меняются. «Слот» в 008 — предел ответа, не эта таблица.

create table model_slots (
  slot_index integer primary key check (slot_index >= 1),
  locked_by text,
  locked_until timestamptz,
  run_id uuid
);
