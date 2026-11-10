-- Предел одного ответа модели. 001 не меняется.
-- Окно слота Ollama 16384. Предел ниже, чтобы заполнение окна
-- и сдвиг контекста не продолжали генерацию.
-- Сервис, которому нужен более длинный ответ, поднимает своё значение.

alter table agents
  add column max_completion_tokens integer not null default 4096
  check (max_completion_tokens between 1 and 8192);
