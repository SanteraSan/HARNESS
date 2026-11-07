# HARNESS

M1 принимает запуск по HTTP или из Telegram, хранит очередь и журнал в Postgres и исполняет один запуск процессом воркера. Модель вызывает только воркер: алиас `agent` через LiteLLM `http://127.0.0.1:4000/v1` (`qwen3.8:latest`). Инструменты воркера — `read_file` и `list_dir`, оба только на чтение внутри `FILE_ROOT`.

Три процесса: `npm run api`, `npm run worker`, `npm run telegram`. Postgres, Ollama и LiteLLM уже слушают порты каталога `/home/santera/dev-ai-stack` (его `README.md`). Команды npm поднимают только процессы HARNESS.

M1 не проводит платежи и не ходит в 1С. Дорожная карта M2 и M3 — в [docs/PLAN.md](docs/PLAN.md).

Операционная последовательность и ожидаемые ответы — в [docs/runbook.md](docs/runbook.md). Ниже тот же путь целиком, чтобы API и воркер поднимались без устных дополнений.

## Что уже должно быть

- Node.js 22. Версия записана в `.nvmrc`, в `package.json` поле `engines` — `>=22 <23`. Проверка: `node -v` печатает `v22`. Если установлен nvm, в корне репозитория выполните `nvm use`.
- Репозиторий стека `/home/santera/dev-ai-stack`. Его README задаёт команды ниже. Секреты стека остаются в его `.env`.
- Postgres стека на `127.0.0.1:5442`. Отдельный кластер не поднимается. Две базы: `harness` и `harness_test`. Имя тестовой базы кончается на `_test`.

## Порты

API слушает `127.0.0.1:8787`. Это константа `API_LISTEN_PORT` в `src/api/server.ts`.

Порты стека и соседних проектов процесс HARNESS не занимает:

| Порт | Кто слушает |
| --- | --- |
| 11434 | Ollama |
| 4000 | LiteLLM |
| 5442 | Postgres |
| 8765 | devmem |
| 3001 | Open WebUI |
| 3000, 5432, 5433, 5678, 6333, 6334, 6379, 8000, 8002, 8080, 9000, 9001, 9090, 18081, 18082, 19092 | заняты TaskFlow, список из README стека |

## Первый запуск

Команды `npm` — из корня этого репозитория. Скрипты читают файл `.env` через `--env-file`. Переменная, уже заданная в shell, перекрывает файл: перед запуском в окружении не должно быть чужого `DATABASE_URL`.

### 1. Зависимости и локальный `.env`

```bash
npm install
cp .env.example .env
```

`.env` в git не входит. В репозитории остаётся `.env.example` с пустыми секретами.

Пользователь и пароль Postgres берутся из строки подключения локального стека, из `/home/santera/dev-ai-stack/.env`. В файле стека это `LITELLM_DATABASE_URL` (в контейнер LiteLLM она попадает как `DATABASE_URL`). Шаблон стека: пользователь `devai`, хост `127.0.0.1`, порт `5442`. Тот же пароль записан в `PG_PASSWORD`. Пароль в этот репозиторий и в этот текст не копируется: его дописывают только в локальный `.env`.

```text
DATABASE_URL=postgres://devai:<пароль из LITELLM_DATABASE_URL>@127.0.0.1:5442/harness
HARNESS_TEST_DATABASE_URL=postgres://devai:<пароль из LITELLM_DATABASE_URL>@127.0.0.1:5442/harness_test
```

Если в пароле есть `@`, `:`, `/`, `#`, `?` или `%`, закодируйте их в URL. Имя во второй строке — `harness_test`.

`LITELLM_BASE_URL` оставьте `http://127.0.0.1:4000/v1`.

`LITELLM_API_KEY` — значение уже выпущенного ключа стека, у которого в списке моделей есть `agent`. По таблице README стека это любой клиентский ключ, кроме `LITELLM_DEVMEM_KEY` (у него только `embed`): например `LITELLM_CONTINUE_KEY` или `LITELLM_TASKFLOW_KEY`. Новый ключ для HARNESS не заводится. Если переменные ключей в `.env` стека пустые, их заполняет существующий скрипт стека `./litellm/issue-keys.sh` (он пишет в `.env` стека). В репозиторий HARNESS значение ключа не попадает.

`HARNESS_API_TOKEN` задайте сами. Процесс API с пустым токеном завершается. В примерах curl ниже стоит плейсхолдер `test-secret-value`: в локальный `.env` можно записать его же или своё значение и подставить это же значение в заголовок. Это не ключ LiteLLM и не токен бота.

Остальные переменные в `.env.example` уже стоят как в разделе конфигурации плана: `AGENT_SLUG=clerk`, `FILE_ROOT=./workspace`, `LEASE_SECONDS=120`, `HEARTBEAT_SECONDS=15`. `WORKER_ID` пустой — воркер берёт имя хоста. `HARNESS_LIVE_MODEL` пустой — живой прогон приёмки пропускается. `TELEGRAM_BOT_TOKEN` и `TELEGRAM_ALLOWED_USER_IDS` пустые, пока бот не нужен.

### 2. Две базы

Postgres уже поднят стеком. Если `127.0.0.1:5442` не слушает, из каталога стека выполните команду его README:

```bash
cd /home/santera/dev-ai-stack
docker compose up -d
```

Базы создаются один раз. SQL из плана, без пароля в команде. Пользователь `devai` — тот же, что в строке подключения стека. Приём такой же, как создание `devmem_test` в README стека: `psql` внутри контейнера.

```bash
cd /home/santera/dev-ai-stack
docker compose exec -T postgres psql -U devai -d postgres -c 'create database harness;'
docker compose exec -T postgres psql -U devai -d postgres -c 'create database harness_test;'
```

Повтор по уже существующему имени отвечает, что база есть: тогда переходите к миграции. Расширение `pgcrypto` создаёт миграция внутри базы, отдельно его включать не нужно.

### 3. Схема и агент `clerk`

В корне HARNESS:

```bash
npm run migrate
npm run seed
```

`migrate` применяет SQL по порядку к базе `harness`. Повторный запуск уже применённые файлы пропускает. `seed` записывает агента `clerk` (`model_alias` `agent`, инструменты `read_file` и `list_dir`). Повтор сида вторую строку с тем же slug не создаёт.

Каталог инструментов — `./workspace`. Воркер создаёт его при старте. Для первого запуска положите туда текст заранее:

```bash
mkdir -p workspace
printf '%s\n' 'hello harness' > workspace/note.txt
```

Каталог `workspace/` в git не входит.

### 4. Прогрев алиаса `agent`

`coder` и `agent` в стеке резидентны по очереди. Перед работой HARNESS загружается профиль `agent`. Команда из README стека, запускать из каталога стека как файл:

```bash
cd /home/santera/dev-ai-stack
./ollama/warmup.sh agent
```

На 16 ГБ для `qwen3.8:latest` ожидается код 2: модель больше видеокарты, часть слоёв остаётся на CPU. Коды расшифрованы в README стека.

Проверка шлюза — команды проверки из того же README. В чате поле `model` здесь `agent`, потому что воркер вызывает этот алиас. Ключ — переменная стека, не новый секрет:

```bash
cd /home/santera/dev-ai-stack
set -a; . ./.env; set +a
curl -s 127.0.0.1:4000/v1/models -H "Authorization: Bearer $LITELLM_CONTINUE_KEY"
curl -s 127.0.0.1:4000/v1/chat/completions -H "Authorization: Bearer $LITELLM_CONTINUE_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"agent","messages":[{"role":"user","content":"Say OK"}]}'
ollama ps
```

В `ollama ps` после прогрева остаются профиль `agent` и `fast`. В список моделей подставьте другую переменную ключа стека, если в `.env` HARNESS записали не `LITELLM_CONTINUE_KEY`: у ключа должен быть доступ к `agent`.

### 5. API и воркер

Два терминала, корень репозитория HARNESS. Оба процесса остаются запущенными.

```bash
npm run api
```

```bash
npm run worker
```

API пишет в лог, что слушает `127.0.0.1:8787`. Воркер обрабатывает одну строку очереди за раз. Остановка воркера не помечает текущий запуск успешным: просроченная аренда возвращает строку в очередь.

Проверка без токена:

```bash
curl -sS -w '\nHTTP %{http_code}\n' http://127.0.0.1:8787/health
```

Ожидается `{"ok":true}` и HTTP 200.

Постановка запуска. Заголовок `Authorization` — то же значение, что `HARNESS_API_TOKEN`. В примере плейсхолдер `test-secret-value`. Поле `chat_id` не передаётся: для такого вызова блокировка диалога не включается. `idempotency_key` — любая строка до 256 символов; повтор того же ключа возвращает ту же строку.

```bash
curl -sS -w '\nHTTP %{http_code}\n' \
  -H 'Authorization: Bearer test-secret-value' \
  -H 'Content-Type: application/json' \
  -d '{"agent_slug":"clerk","idempotency_key":"local-1","message":"Прочитай файл note.txt и назови его содержимое."}' \
  http://127.0.0.1:8787/v1/runs
```

Ожидается HTTP 201 и JSON с `reason` `created`, `status` `queued` и `id`. Тот же ключ ещё раз — HTTP 200 и `reason` `replay`, тот же `id`. Неизвестный `agent_slug` — HTTP 404 и `reason` `unknown_agent`. Запрос без заголовка или с другим токеном — HTTP 401.

Дальше возьмите поле `id` из ответа POST (это UUID запуска, не slug агента) и подставьте его вместо `<id>`, без угловых скобок:

```bash
RUN_ID="<id>"
curl -sS -w '\nHTTP %{http_code}\n' \
  -H 'Authorization: Bearer test-secret-value' \
  "http://127.0.0.1:8787/v1/runs/${RUN_ID}"
```

Повторяйте `GET`, пока `run.status` не станет `succeeded` или `failed`. У `succeeded` текст ответа в `run.final_text`. Шаги лежат в `steps` по возрастанию `step_index`. Пока статус `queued`, воркер строку ещё не забрал. Конечный `failed` при уже записанных шагах означает, что очередь и воркер ход завершили; живая модель может ошибиться в выборе файла.

Новый запуск — новый `idempotency_key`.

### 6. Тесты

База `harness_test` уже создана, `HARNESS_TEST_DATABASE_URL` указывает на неё:

```bash
npm test
```

Хелпер отказывается работать, если имя базы не кончается на `_test`. Живой вызов `qwen` в этом прогоне выполняется только при `HARNESS_LIVE_MODEL=1`. Пустое значение — пропуск, это норма.

## Telegram

Пока бот не нужен, `TELEGRAM_BOT_TOKEN` в `.env` остаётся пустым, как в `.env.example`. Процесс с пустым токеном завершается. Токен в репозиторий не пишется.

Чтобы включить бота, в локальный `.env` запишите:

- `TELEGRAM_BOT_TOKEN` — токен бота от BotFather;
- `TELEGRAM_ALLOWED_USER_IDS` — числовые id пользователей через запятую, например `123456789,987654321` как образец формата, не как чей-то настоящий id;
- `AGENT_SLUG` оставьте `clerk`.

Третий терминал, после `npm run seed` и рядом с уже запущенным воркером:

```bash
npm run telegram
```

Процесс бота ставит запуск и затем читает его статус. Модель вызывает воркер, поэтому без воркера ответ модели не появится. API для бота не обязателен. Пользователь не из списка получает отказ, запуск не создаётся. Файл, стикер и пустое сообщение не ставятся в очередь: в этом срезе принимается только текст. Свой текст бот отвечает фразой «Запуск принят» и id, по конечному статусу присылает `final_text` или короткую фразу об ошибке.

## Если процесс сразу не тот

| Что видно | Что проверить |
| --- | --- |
| `npm run api` сразу выходит | `HARNESS_API_TOKEN` пустой |
| `GET /health` не открывается | процесс API запущен, порт 8787 свободен до него |
| POST отвечает 401 | заголовок `Bearer` совпадает с `HARNESS_API_TOKEN` |
| POST отвечает 404 `unknown_agent` | выполнен `npm run seed`, в теле `agent_slug` равен `clerk` |
| статус остаётся `queued` | запущен `npm run worker`, в shell нет чужого `DATABASE_URL` |
| запуск сразу `failed`, шага модели нет | `LITELLM_API_KEY` — ключ стека с моделью `agent`, шлюз на `127.0.0.1:4000` отвечает, выполнен `./ollama/warmup.sh agent` |
| `npm run telegram` сразу выходит | `TELEGRAM_BOT_TOKEN` записан только в локальный `.env` |
