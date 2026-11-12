# Локальный запуск M1

Поднять API и воркер. Секреты в этот файл не записываются: пароль Postgres и ключ LiteLLM берутся из `/home/santera/dev-ai-stack/.env`, токен API человек задаёт сам. Объяснение тех же шагов — в [README](../README.md). Команды стека — в его README, здесь только ссылки на уже существующие.

M1 не проводит платежи и не ходит в 1С. Дорожная карта M2 и M3 — в [PLAN.md](PLAN.md).

Скрипты npm читают `.env` в корне репозитория (`--env-file=.env`). Значение, уже экспортированное в shell, перекрывает файл. Перед командами проверьте, что в окружении нет чужого `DATABASE_URL`.

## Порты

API слушает `127.0.0.1:8787` (`API_LISTEN_PORT` в `src/api/server.ts`).

HARNESS не занимает порты стека и TaskFlow:

| Порт | Сервис |
| --- | --- |
| 11434 | Ollama |
| 4000 | LiteLLM |
| 5442 | Postgres стека |
| 8765 | devmem |
| 3001 | Open WebUI |
| 3000, 5432, 5433, 5678, 6333, 6334, 6379, 8000, 8002, 8080, 9000, 9001, 9090, 18081, 18082, 19092 | TaskFlow, список из README стека |

Перед стартом API порт 8787 свободен. Postgres и шлюз уже слушают свои адреса:

```bash
ss -ltn | grep -E '127.0.0.1:5442|127.0.0.1:4000|127.0.0.1:11434'
```

Если 5442 или 4000 молчат, из каталога стека: `docker compose up -d`.

## Базы

Один раз, на уже поднятом Postgres `127.0.0.1:5442`. Пользователь и пароль — из `LITELLM_DATABASE_URL` в `/home/santera/dev-ai-stack/.env` (пользователь `devai`, тот же пароль в `PG_PASSWORD`). В команду создания пароль не входит: `psql` идёт внутри контейнера, как создание `devmem_test` в README стека.

```bash
cd /home/santera/dev-ai-stack
docker compose exec -T postgres psql -U devai -d postgres -c 'create database harness;'
docker compose exec -T postgres psql -U devai -d postgres -c 'create database harness_test;'
```

SQL из плана: `create database harness` и `create database harness_test`. Имя тестовой базы кончается на `_test`. Ответ «уже существует» на повторной подготовке значит, что шаг уже сделан.

В локальном `.env` HARNESS те же пользователь и пароль, другие имена баз:

```text
DATABASE_URL=postgres://devai:<пароль из LITELLM_DATABASE_URL>@127.0.0.1:5442/harness
HARNESS_TEST_DATABASE_URL=postgres://devai:<пароль из LITELLM_DATABASE_URL>@127.0.0.1:5442/harness_test
```

Символы `@`, `:`, `/`, `#`, `?`, `%` в пароле кодируются в URL. Расширение `pgcrypto` создаёт `npm run migrate`.

## Переменные, без которых API и воркер не доходят до ответа

| Переменная | Значение M1 |
| --- | --- |
| `DATABASE_URL` | база `harness`, пользователь и пароль из строки стека |
| `HARNESS_TEST_DATABASE_URL` | база `harness_test` |
| `LITELLM_BASE_URL` | `http://127.0.0.1:4000/v1` |
| `LITELLM_API_KEY` | готовый ключ стека с моделью `agent` |
| `HARNESS_API_TOKEN` | свой bearer; в примерах плейсхолдер `test-secret-value` |
| `AGENT_SLUG` | `clerk` |
| `FILE_ROOT` | `./workspace` |
| `WORKER_ID` | пусто, тогда имя хоста |
| `LEASE_SECONDS` | `120` |
| `HEARTBEAT_SECONDS` | `15` |
| `HARNESS_LIVE_MODEL` | пусто |
| `TELEGRAM_BOT_TOKEN` | пусто, пока бот выключен |
| `TELEGRAM_ALLOWED_USER_IDS` | пусто, пока бот выключен |

Ключ с моделью `agent` в стеке уже выпускается `./litellm/issue-keys.sh`. Подходит `LITELLM_CONTINUE_KEY`, `LITELLM_TASKFLOW_KEY` и остальные клиентские ключи той таблицы, кроме `LITELLM_DEVMEM_KEY`. Значение копируется в локальный `.env` HARNESS и в git не коммитится.

`HARNESS_API_TOKEN` пустым не оставляют: `npm run api` с пустым токеном завершается. Плейсхолдер примеров — `test-secret-value`. В заголовок идёт ровно та строка, которая лежит в `.env`.

## Алиас `agent`

Из каталога стека, команда его README:

```bash
cd /home/santera/dev-ai-stack
./ollama/warmup.sh agent
```

Проверка тем же приёмом, что в README стека. Модель в теле — `agent`:

```bash
cd /home/santera/dev-ai-stack
set -a; . ./.env; set +a
curl -s 127.0.0.1:4000/v1/models -H "Authorization: Bearer $LITELLM_CONTINUE_KEY"
curl -s 127.0.0.1:4000/v1/chat/completions -H "Authorization: Bearer $LITELLM_CONTINUE_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"agent","messages":[{"role":"user","content":"Say OK"}]}'
ollama ps
```

После прогрева `ollama ps` показывает `qwen3.8:latest`. На 16 ГБ код выхода `warmup.sh` 2 ожидаем: модель загружена, но не целиком на GPU. Код 0 у этого профиля на этой карте не обещается.

## Процессы HARNESS

Node 22, как в `.nvmrc`. Из корня репозитория один раз скопируйте шаблон (файл `.env` в git не входит):

```bash
cp .env.example .env
```

Впишите в него `DATABASE_URL`, `HARNESS_TEST_DATABASE_URL`, `LITELLM_API_KEY` и `HARNESS_API_TOKEN` по таблице выше. Затем:

```bash
npm install
npm run migrate
npm run seed
mkdir -p workspace
printf '%s\n' 'hello harness' > workspace/note.txt
```

`migrate` и `seed` ходят в `DATABASE_URL` (`harness`) и завершаются. Повтор безопасен: миграция пропускает записанную версию, сид не создаёт второго `clerk`.

Два долгих процесса, два терминала:

```bash
npm run api
```

```bash
npm run worker
```

Воркер держит один запуск. `Ctrl+C` не ставит ему статус `succeeded`.

Число процессов воркера и число слотов задаёт установка, по умолчанию оба равны 1. Хаб `num_parallel` не читает и из имени модели слоты не выводит.

`MODEL_SLOTS` в `.env` — целое не меньше 1. Столько же строк вставляет человек после миграции:

```sql
insert into model_slots (slot_index) values (1);
```

Для двух слотов — значения `(1), (2)` и `MODEL_SLOTS=2`. Пока строка занята, число не меняют. Строку с непустым `locked_by` не удаляют. На старте воркер сверяет `count(*)` с `MODEL_SLOTS` и выходит до захвата, если они разошлись.

Второй процесс — второй экземпляр `harness-worker@<id>` с другим `WORKER_ID`. Шаблон юнита: `deploy/systemd/harness-worker@.service`. В нём `WORKER_ID=%i`, `NoNewPrivileges=yes`, `ProtectSystem=strict`. `ReadWritePaths` не включает `FILE_ROOT` и `BLOB_ROOT`. Путь юнита выбирает установка. Два ручных `npm run worker` без разных `WORKER_ID` сольют локи: код процессы не порождает и файловый лок не ставит. Один ручной процесс без `WORKER_ID` берёт имя хоста.

`GET /health` без токена:

```bash
curl -sS -w '\nHTTP %{http_code}\n' http://127.0.0.1:8787/health
```

Ожидается HTTP 200 и `{"ok":true}`.

`POST /v1/runs`. Тело — JSON, поле `message` до 8000 символов. Bearer — `HARNESS_API_TOKEN`. В команде плейсхолдер `test-secret-value`.

```bash
curl -sS -w '\nHTTP %{http_code}\n' \
  -H 'Authorization: Bearer test-secret-value' \
  -H 'Content-Type: application/json' \
  -d '{"agent_slug":"clerk","idempotency_key":"local-1","message":"Прочитай файл note.txt и назови его содержимое."}' \
  http://127.0.0.1:8787/v1/runs
```

| HTTP | `reason` | Смысл |
| --- | --- | --- |
| 201 | `created` | строка `queued`, в теле есть `id` |
| 200 | `replay` | тот же `idempotency_key`, тот же `id` |
| 409 | `dialog_busy` | у этого `chat_id` уже есть живой запуск; в примере поля нет |
| 404 | `unknown_agent` | slug не `clerk` или сид не применялся |
| 401 | `unauthorized` | нет bearer или он не равен `HARNESS_API_TOKEN` |

Чтение. Замените `<id>` на поле `id` из ответа POST, без угловых скобок:

```bash
RUN_ID="<id>"
curl -sS -w '\nHTTP %{http_code}\n' \
  -H 'Authorization: Bearer test-secret-value' \
  "http://127.0.0.1:8787/v1/runs/${RUN_ID}"
```

Повторять, пока `run.status` не станет `succeeded` или `failed`. Текст успеха — `run.final_text`. Шаги — массив `steps`. Статус `queued` дольше пары секунд значит, что воркер не запущен или смотрит в другую базу.

Следующий запуск — другой `idempotency_key`.

## Бот

`TELEGRAM_BOT_TOKEN` в репозитории пустой. Для включения в локальный `.env` записываются токен BotFather и `TELEGRAM_ALLOWED_USER_IDS` (числовые id через запятую). `AGENT_SLUG` остаётся `clerk`.

Рядом с воркером:

```bash
npm run telegram
```

Бот ставит запуск и опрашивает статус. Модель вызывает воркер. Чужой id получает отказ без строки в очереди. Принимается только текст.

## Тесты

```bash
npm test
```

Нужна уже созданная `harness_test`. Имя в URL кончается на `_test`, иначе хелпер падает до очистки. `HARNESS_LIVE_MODEL` пустой — живой `qwen` пропускается.

## Что смотреть в терминале

| Наблюдение | Причина |
| --- | --- |
| API сразу выходит | пустой `HARNESS_API_TOKEN` |
| Telegram сразу выходит | пустой `TELEGRAM_BOT_TOKEN` |
| POST 401 | bearer не совпал с токеном в `.env` |
| POST 404 `unknown_agent` | не выполнен `npm run seed` |
| `queued` не меняется | не запущен воркер или shell подменил `DATABASE_URL` |
| `failed` без шага модели | пустой `LITELLM_API_KEY`, шлюз не на `127.0.0.1:4000` или не выполнен `./ollama/warmup.sh agent` |
| `failed` после шагов | воркер ход закончил; ошибка выбора файла моделью ход очереди не отменяет |
