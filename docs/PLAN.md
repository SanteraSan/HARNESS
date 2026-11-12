---
name: HARNESS local development
overview: "Канонический план локального HARNESS. Сначала вертикальный срез на одной локальной модели, затем тот же раннер с внешними моделями, затем второй раннер Claude Agent SDK. Оркестратор раздаёт пакеты по волнам, агенты не выходят за exclusive paths и сверяются с инвариантами I1–I20."
todos:
  - id: m1-p0
    content: "M1-P0 Каркас, контракты, миграция 001, пустой resolveModel, закрытый список зависимостей"
    status: done
  - id: m1-p1
    content: "M1-P1 Очередь: enqueue с идемпотентностью и блокировкой диалога, claim SKIP LOCKED, heartbeat, reaper"
    status: done
  - id: m1-p2
    content: "M1-P2 Реестр инструментов, default-deny, read_file и list_dir в FILE_ROOT"
    status: done
  - id: m1-p3
    content: "M1-P3 Клиент LiteLLM и правила разбора native tool_calls"
    status: done
  - id: m1-p4
    content: "M1-P4 Журнал run_steps и redact до записи и до следующего хода модели"
    status: done
  - id: m1-p5
    content: "M1-P5 OpenAICompatRunner: цикл, потолок шагов, потеря лока"
    status: done
  - id: m1-p6
    content: "M1-P6 Процесс воркера: reaper, один claim, heartbeat, финиш"
    status: done
  - id: m1-p7
    content: "M1-P7 HTTP: health, POST /v1/runs, GET /v1/runs/:id, bearer"
    status: done
  - id: m1-p8
    content: "M1-P8 Telegram: long polling, allowlist пользователей, enqueue, ответ по завершению"
    status: done
  - id: m1-p9
    content: "M1-P9 Приёмка: семь учений на живой Postgres и опциональный живой прогон модели"
    status: done
  - id: m1-p10
    content: "M1-P10 README и runbook локального запуска"
    status: done
  - id: m2-p1
    content: "M2-P1 Маршрут: route_rules, resolveModel, cost_usd, внешний алиас на фейковом клиенте"
    status: done
  - id: m2-p2
    content: "M2-P2 record_note: идемпотентная запись в FILE_ROOT/out"
    status: done
  - id: m2-p3
    content: "M2-P3 Делегирование: create_subtask и approve"
    status: done
  - id: m2-p4
    content: "M2-P4 Кроны: script и agent, пауза после трёх провалов"
    status: done
  - id: m2-p5
    content: "M2-P5 Буфер диалога Telegram и отметка доставки"
    status: done
  - id: m2-p6
    content: "M2-P6 Приёмка M2"
    status: done
  - id: m3-p1
    content: "M3-P1 ClaudeSdkRunner по provider из resolveModel"
    status: done
  - id: m3-p2
    content: "M3-P2 Контейнер на запуск"
    status: done
  - id: m3-p3
    content: "M3-P3 Секреты коннекторов"
    status: done
  - id: m3-p4
    content: "M3-P4 Админка"
    status: pending
  - id: m3-p5
    content: "M3-P5 Политика только внешние"
    status: done
  - id: m3-p6
    content: "M3-P6 Выбор локальной или внешней модели в чате Telegram"
    status: done
  - id: m3-p7
    content: "M3-P7 Внешний чат без инструментов и с минимальным размышлением"
    status: ready
  - id: m4-p1
    content: "M4-P1 Шлюз картинок FLUX.2 Klein 4B: одна видеокарта, генерация и правка"
    status: pending
  - id: m4-p2
    content: "M4-P2 Команды картинки в Telegram"
    status: pending
  - id: m4-p3
    content: "M4-P3 Тот же шлюз из чата TaskFlow"
    status: pending
  - id: m5-p1
    content: "M5-P1 Вызов сервиса и отчёт harness.tool.v2"
    status: pending
isProject: false
---

# HARNESS — план разработки

Канонический документ. Когда репозиторий [SanteraSan/HARNESS](https://github.com/SanteraSan/HARNESS) открыт локально, этот файл копируется в `docs/PLAN.md` и дальше живёт только там. Холст с разбором вакансии — контекст, не спецификация. Если код и этот документ расходятся, прав оркестратор: сначала правка плана, потом код.

Правила агентов лежат в репозитории: `/home/santera/ALL PROJECTS/HARNESS/.cursor/rules/` и короткий вход `AGENTS.md`. План задаёт, что строить. Правила задают, как писать и как оркестратор выдаёт пакеты. Расхождение правил с инвариантами этого файла чинит оркестратор в обоих местах до кода.

Репозиторий лежит вне workspace `/home/santera/Projects`. `git` и `gh` из песочницы не видят ключ в связке и отвечают отказом, хотя доступ есть. Любая команда к этому каталогу и к GitHub запускается с полным доступом, без песочницы. Отказ из песочницы не считается недоступностью репозитория.

Код по этому плану не пишется, пока оркестратор не назначен пакет. Этот файл сам по себе пакет не открывает.

## 1. Что строим тремя этапами

Один репозиторий, один контракт запуска, три способа выбрать модель.

| Этап | Когда | Что меняется | Что уже работает и не переписывается |
| --- | --- | --- | --- |
| M1 Локально | сейчас | Очередь, журнал, один раннер через LiteLLM, алиас `agent`, инструменты только на чтение, один Telegram-бот | — |
| M2 Локально и внешние | после приёмки M1 | Правила маршрута, эскалация после кривого tool call, инструменты с побочным эффектом, делегирование, кроны двух типов | Очередь, журнал, Telegram, `Runner` |
| M3 Только внешние | после приёмки M2 | Второй раннер Claude Agent SDK, контейнер на запуск, сейф секретов, админка | Тот же журнал и та же очередь. Локальный раннер остаётся для тестов |

M3 не удаляет локальный путь. «Только внешние» значит, что политика больше не выбирает локальный алиас.

M1 — вертикальный срез, на котором проверяются инварианты. Это ближе к их тестовому (очередь, запуск, журнал), плюс один бот и два безопасных инструмента, без которых срез нельзя пощупать руками.

## 2. Как планом пользуются агенты

Роли на время разработки, не путать с агентами продукта:

- **Оркестратор.** Единственный, кто меняет таблицу статусов в этом файле. Назначает один пакет одному агенту. Не пишет продуктовую логику. Не принимает «заодно поправил соседний модуль».
- **Исполнитель.** Один пакет. Читает раздел пакета, инварианты и контракты. Пишет код только в `exclusive_paths`. В конце сдаёт отчёт по шаблону.
- **Ревьюер.** После волны, не после каждого файла. Сверяет дифф с инвариантами I1–I20 и с DoD пакетов волны. Мелочь (тип, имя, очевидный пропуск теста из DoD) может поправить сам. Смена контракта или схемы — стоп, обратно оркестратору.
- **Приёмка.** Только пакет M1-P9. Продуктовую логику не чинит. Красный сценарий возвращает оркестратору с именем пакета-владельца.

### 2.1. Статусы пакетов

`pending` — зависимости не закрыты. `ready` — оркестратор разрешил брать. `in_progress` — выдан агенту. `done` — DoD выполнен, ревьюер волны не нашёл нарушения инварианта. `blocked` — агент остановился, в отчёте написано почему.

Исполнитель не переводит пакет в `done`. Это делает оркестратор после отчёта и, для конца волны, после ревьюера.

### 2.2. Параллельность

Параллельно работают только пакеты одной волны, у которых `exclusive_paths` не пересекаются. Каждый такой пакет — отдельный git worktree и ветка `m1/<id>`. Оркестратор вливает их в `main` по порядку номеров. Два агента в одном рабочем каталоге не запускаются: они перезапишут друг друга.

Пока P0 не `done`, других пакетов нет. Контракты и миграции после P0 меняет только отдельное задание оркестратора. Агент, которому не хватает поля в контракте, останавливается и пишет `blocked`. Сам контракт он не расширяет.

Новые зависимости npm в M1 не добавляются. Список закрыт в P0. Нужна библиотека — `blocked`.

### 2.3. Шаблон задания

```text
Пакет: M1-P1
План: docs/PLAN.md, раздел пакета и инварианты I1–I20.
Правила: .cursor/rules/*.mdc и AGENTS.md. Команды shell только без песочницы.
Ветка: m1/p1-queue
Можно менять только: <exclusive_paths>
Нельзя: контракты, миграции, чужие каталоги, новые зависимости, пакеты M2/M3.
Готово, когда выполнен DoD пакета и названные тесты зелёные.
Отчёт: файлы, команды тестов и итог, чеклист DoD, отклонения. Отклонение от инварианта — не отклонение, а блокер.
```

### 2.4. Шаблон отчёта

```text
Пакет:
Тесты: команда и результат
DoD: пункт — да/нет
Инварианты, которые пакет затрагивает: номер — как соблюдён
Файлы:
Блокеры:
```

### 2.5. Какой пакет брать следующим

Следующий пакет текста после M3-P7 — M5-P1. Выдавать его, когда M3-P7 `done` и `exclusive_paths` M3-P7 свободны. Параллельно с M3-P7 не выдавать. M4 не ждать: картинки остаются `pending`, пока человек не попросил их реализовать. M3-P4 этим правилом не открывается: у него по-прежнему нет DoD. Код `harness-files` начинается после `done` у M5-P1.

## 3. Зафиксированные решения

Их не переоткрывают внутри пакета.

1. Язык M1 — TypeScript, Node 22, ESM. Python-проекты остаются донорами поведения. Их код в этот репозиторий не переносится.
2. HTTP — Hono. Процессы API, воркер и Telegram разделены. Модель вызывает только воркер.
3. База — уже поднятый Postgres на `127.0.0.1:5442`. Отдельный кластер не поднимаем. Две базы: `harness` и `harness_test`. Имя тестовой базы обязано кончаться на `_test`, иначе тестовый хелпер отказывается работать.
4. Доступ к SQL — библиотека `postgres` (postgres.js) и файлы миграций. ORM нет: захват очереди должен быть виден как один `UPDATE … FOR UPDATE SKIP LOCKED`.
5. Схема запросов и тел — zod.
6. Тесты — vitest.
7. Логи — pino, в строке есть `run_id`, когда он известен.
8. Telegram — grammY, long polling.
9. Модель M1 — алиас `agent` через LiteLLM `http://127.0.0.1:4000/v1`. Это `qwen3.8:latest`. Алиас `coder` для агента не используется.
10. Раннер читает только поле `tool_calls`. JSON в тексте ответа не исполняется.
11. Воркер M1 держит строго один запуск. Пула нет.
12. Секреты в репозиторий не коммитятся. В журнале и в следующем запросе модели их нет.
13. `tenant_id` есть с первой миграции. В M1 значение `local`.

Закрытый список зависимостей M1: `hono`, `grammy`, `postgres`, `zod`, `pino`, `vitest`, `typescript`, `tsx`, типы Node и eslint. Запрещены в M1: Claude Agent SDK, LangChain, LangGraph, Prisma, Drizzle, TypeORM, Redis, BullMQ.

## 4. Инварианты

Ревьюер цитирует номер.

- **I1.** Очередь не импортирует клиент модели. Модель стоит за интерфейсом `Runner`.
- **I2.** Исполняется только native `tool_calls`. Текст, который парсится как JSON с вызовом инструмента, даёт шаг `parse_error` и не исполняется. Сырой JSON не записывается в `final_text`.
- **I3.** Инструмент вне allowlist агента и инструмент из списка запрета не вызывается. Запрет побеждает allowlist.
- **I4.** `redact` проходит до вставки шага и до того, как результат инструмента попадает в следующее сообщение модели.
- **I5.** Пара `(agent_id, idempotency_key)` уникальна. Повтор возвращает ту же строку, вторая не создаётся.
- **I6.** Если у того же агента и того же `chat_id` есть запуск в `queued` или `running`, новый запуск не создаётся. Возвращается живой.
- **I7.** Захват — один `UPDATE` с `FOR UPDATE SKIP LOCKED`. Пока запуск жив, воркер продлевает `locked_until`. Ноль строк у heartbeat или у финиша значит, что лок потерян: статус `succeeded` этот воркер не ставит и новые шаги не пишет.
- **I8.** `attempt` увеличивается в момент захвата. Просроченная аренда возвращает строку в `queued`, пока `attempt < max_attempts`, иначе `failed`. Успешный запуск повторно не исполняется.
- **I9.** У `agents` и `runs` есть `tenant_id`.
- **I10.** Алиас и провайдер на запуске проставляет `resolveModel`. В M1 он возвращает поля строки агента и ничего не переключает.
- **I11.** Колонки `parent_run_id`, `not_before`, `deadline_at`, `source` есть. В M1 делегирование, кроны и дедлайны не реализованы. `source` принимает `api` и `telegram`.
- **I12.** Инструменты M1 имеют `effect: "read"`. Сетевых вызовов в инструментах нет.
- **I13.** Один процесс воркера — один текущий запуск.
- **I14.** Процесс Telegram только ставит запуск и потом читает его статус. Модель он не вызывает.
- **I15.** Список зависимостей M1 закрыт.
- **I16.** Статусы в этом плане пишет оркестратор.
- **I17.** `src/contracts/**` и `migrations/**` после P0 не трогает исполнитель.
- **I18.** Упавший тест не ослабляют, чтобы стал зелёным. Чинится код или уточняется план.
- **I19.** `FILE_ROOT` — тюрьма: `realpath`, отказ на `..`, отказ на симлинк, который выходит из корня. Лимит чтения 64 КиБ, только UTF-8.
- **I20.** Ключ API, токен бота и ключ LiteLLM сравниваются и пишутся в логи только через redact. В фикстурах тестов используются заведомо фейковые значения.

## 5. Доноры поведения

Брать смысл, не файлы.

| Откуда | Что повторить | Что не переносить |
| --- | --- | --- |
| Local-AI-dev-stack | LiteLLM на `127.0.0.1:4000`, алиас `agent`, Postgres `:5442` | Облачный fallback. Он выключен и относится к M2 |
| TaskFlow `permissions.py` | Неизвестный инструмент запрещён. Проверка до вызова | Цикл на `ollama.generate` и разбор JSON из текста. Потолок в 4 шага. Подстановка сырого текста как ответа |
| TaskFlow | Память и постановка — контекст. Результат инструмента — данные шага | RAG, Qdrant, Keycloak |
| ChatBot-with-MCP `service.go` | Пока прогон жив, второй не стартует. Ответ уходит в тот чат, который начал | Webhook Cursor, память процесса, один бот на все команды |
| Freedom `tool_policy.py` | Список `ALWAYS_DENIED_TOOLS`: Bash, Read, Write, Edit и snake_case-двойники | Anthropic SDK, `asyncio` субагенты, роли PF5 |

`devmem` в M1 не подключаем. Поиск по памяти компании — отдельный инструмент M2, тем же интерфейсом `Tool`.

## 6. Процессы M1

```text
Telegram (grammY) ──enqueue──┐
HTTP API (Hono)   ──enqueue──┼──> Postgres harness
                              │         │
                              │         ▼
                              │    worker, один запуск
                              │         │
                              │         ├── resolveModel → алиас agent
                              │         ├── LiteLLM /v1/chat/completions
                              │         ├── tools read_file | list_dir
                              │         └── run_steps
                              ▼
                        ответ в Telegram читает статус и final_text
```

Три команды: `npm run api`, `npm run worker`, `npm run telegram`. Стек LiteLLM и Ollama этой командой не поднимается. В README написано, что они уже должны слушать свои порты, и как проверить алиас `agent`.

Один запуск:

1. Клиент вызывает постановку.
2. В одной транзакции: повтор ключа идемпотентности, затем живой диалог, затем `INSERT` в `queued`.
3. Воркер снимает просроченные аренды, захватывает одну строку, вызывает `Runner`.
4. Раннер на каждом ходе пишет шаг, зовёт модель, либо исполняет разрешённые инструменты, либо завершает запуск.
5. Heartbeat во время хода. Потеря лока обрывает раннер без `succeeded`.
6. Telegram-процесс опрашивает свой запуск и отправляет `final_text` один раз.

## 7. Нормативная схема

Миграция `migrations/001_init.sql`. Пишет её только P0. Ниже спецификация, не файл в репозитории, пока P0 не начат.

```sql
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
```

Смысл полей, которые в M1 только хранятся:

- `parent_run_id` — для M2, когда менеджер создаёт дочерний запуск. В M1 всегда `null`.
- `not_before` — для крона M2. Захват уже уважает это поле, чтобы не менять SQL потом.
- `deadline_at` — хранится, на порядок захвата и на статус в M1 не влияет.
- `priority` — меньше число, раньше захват. По умолчанию 100.
- `source = cron | delegation` вставить можно, поведения под них нет. Тест P0 проверяет, что check-ограничение их принимает, и на этом их использование заканчивается.

`payload` M1 — объект `{"message": string}`. Других полей раннер не читает.

Сид `seed/local_agent.sql`, не часть миграции схемы. Фиксированный id `00000000-0000-4000-8000-000000000001`, `tenant_id = local`, `slug = clerk`, `model_alias = agent`, `provider = local`, `max_steps = 8`, allowlist `read_file` и `list_dir`. Системный промпт на русском, до 800 знаков: отвечай по результатам инструментов, не выдумывай содержимое файлов, инструменты только из списка, окончательный ответ обычным текстом без предисловия и без разметки.

Пользователь базы и пароль берутся из `DATABASE_URL`. В плане и в репозитории пароля нет. Однократная подготовка, её выполняет человек, не агент:

```sql
create database harness;
create database harness_test;
```

Расширение `pgcrypto` создаёт миграция внутри базы.

## 8. Контракты

Каталог `src/contracts/`. Только типы и чистые функции разбора. Без ввода-вывода. Реализация интерфейсов лежит в каталогах пакетов.

```text
RunStatus = queued | running | succeeded | failed | cancelled
StepKind  = model_request | tool_call | tool_result | policy_deny | parse_error | final | lock_lost
Provider  = local | external
ToolEffect = read | write
Source = api | telegram | cron | delegation
```

```text
interface Tool {
  name: string
  description: string
  effect: ToolEffect
  parameters: ZodSchema
  execute(args: unknown, ctx: ToolContext): Promise<ToolOutcome>
}

interface ToolContext {
  runId: string
  agentId: string
  fileRoot: string
}

interface ChatModel {
  complete(input: ModelInput): Promise<ModelOutput>
}

interface ModelOutput {
  content: string | null
  toolCalls: Array<{ id: string; name: string; arguments: string }>
  promptTokens: number | null
  completionTokens: number | null
  model: string
}

interface Runner {
  run(claimed: ClaimedRun, ctx: RunnerContext): Promise<void>
}
```

`Runner` ничего не возвращает наружу. Итог он записывает финишем очереди, и только если лок ещё его. Так M3 сможет подставить другой `Runner`, не меняя воркер.

`resolveModel(agent) -> { modelAlias, provider }` в M1 возвращает `agent.modelAlias` и `agent.provider`.

Разбор ответа модели, чистая функция `interpretModelOutput`:

- есть хотя бы один элемент в `toolCalls` → `{ type: "tools", calls }`
- `toolCalls` пуст, `content` пустой или `null` → `{ type: "parse_error", reason: "empty" }`
- `toolCalls` пуст, а `content` после `trim` целиком парсится как JSON-объект, у которого есть `tool_calls` или пара `name` и `arguments` → `{ type: "parse_error", reason: "json_in_text" }`
- иначе → `{ type: "final", text: content }`

Функция не ходит в сеть и не режет текст «примерно как JSON». Либо весь текст — один JSON-объект указанной формы, либо это ответ пользователю.

Запрещённые имена, множество, регистр как в списке. Запрет проверяется по имени без учёта регистра:

`Bash`, `Read`, `Write`, `Edit`, `MultiEdit`, `Glob`, `Grep`, `LS`, `TodoRead`, `TodoWrite`, `WebFetch`, `WebSearch`, `bash`, `read`, `write`, `edit`, `multi_edit`, `glob`, `grep`, `ls`, `todo_read`, `todo_write`, `web_fetch`, `web_search`.

`read_file` и `list_dir` в этот список не входят. Это разные имена, не встроенные файловые инструменты SDK.

Очередь, которую реализует P1 и которую вызывают API и Telegram:

```text
enqueue(input: {
  tenantId: string
  agentId: string
  source: "api" | "telegram"
  idempotencyKey: string
  message: string
  chatId: bigint | null
  priority?: number
}): Promise<{ run: RunRecord; created: boolean; reason: "created" | "replay" | "dialog_busy" }>

claimNext(workerId: string, leaseSeconds: number): Promise<ClaimedRun | null>
heartbeat(runId: string, workerId: string, leaseSeconds: number): Promise<boolean>
reapExpired(): Promise<number>
finish(runId, workerId, outcome): Promise<boolean>
```

`finish` возвращает `false`, если строка уже не в `running` у этого `workerId`.

Аренда M1 — 120 секунд. Heartbeat — каждые 15 секунд. Оба числа в конфиге, не размазаны по файлам.

Ключ идемпотентности Telegram: `tg:{agentId}:{updateId}`.

Обрезка выдержек — 2000 символов Unicode. `redact` заменяет на `[redacted]` вхождения значений из списка, который процесс собрал из окружения (`DATABASE_URL`, токены, ключи), плюс подстроки, похожие на `sk-`, `Bearer `, `bot` токен Telegram вида цифры, двоеточие, 30+ символов. Тест задаёт фейковый секрет и проверяет оба канала.

## 9. SQL поведения очереди

Норматив для P1.

Постановка в одной транзакции:

1. `select … from runs where agent_id = $1 and idempotency_key = $2 for update`. Нашли — вернуть её, `created: false`, `reason: replay`.
2. Если `chatId` не `null`: `select id from runs where agent_id = $1 and chat_id = $2 and status in ('queued','running') for update`. Нашли — вернуть эту строку, `reason: dialog_busy`.
3. Иначе `insert` со статусом `queued`, `attempt = 0`.

Захват:

```sql
update runs
set status = 'running',
    locked_by = $worker,
    locked_until = now() + make_interval(secs => $lease),
    attempt = attempt + 1,
    started_at = coalesce(started_at, now())
where id = (
  select id
  from runs
  where status = 'queued'
    and attempt < max_attempts
    and (not_before is null or not_before <= now())
  order by priority asc, created_at asc
  for update skip locked
  limit 1
)
returning *;
```

Снятие просрочки до захвата:

```sql
update runs
set status = case when attempt >= max_attempts then 'failed' else 'queued' end,
    error = case when attempt >= max_attempts then 'lease expired' else error end,
    finished_at = case when attempt >= max_attempts then now() else finished_at end,
    locked_by = null,
    locked_until = null
where status = 'running'
  and locked_until is not null
  and locked_until < now();
```

Heartbeat и финиш обновляют строку только при `id`, `locked_by` и `status = 'running'`.

Два параллельных захвата в тесте обязаны использовать два соединения. Мокать SQL нельзя: тест открывает реальный `harness_test`.

## 10. Поведение раннера

Реализует P5. На входе запуск уже в `running` и принадлежит воркеру.

1. Собрать список инструментов: пересечение реестра, `tool_allowlist` агента и дополнение запретного списка. Запрещённое имя отбрасывается даже при наличии в allowlist. Исключение пишет M3-P7: чат с алиасом `coder-cloud` получает пустой список.
2. Сообщения: системный промпт агента, затем одно пользовательское сообщение `payload.message`.
3. Цикл от 1 до `max_steps`.
4. Перед вызовом модели — heartbeat. `false` → выйти, не писать шаг.
5. Записать `model_request` с именем модели из `resolveModel` и обрезком постановки. Текст инструментов целиком в выдержку не класть.
6. Вызвать `ChatModel.complete`.
7. `tools` → для каждого вызова: политика, затем `execute` или шаг `policy_deny`. Результат или отказ добавить в историю как сообщение роли `tool`. Шаги `tool_call` и `tool_result` писать до следующего вызова модели.
8. `final` → `finish(succeeded)` с `final_text`. Выйти.
9. `parse_error` → шаг `parse_error`, `finish(failed)`, в `error` причина `empty` или `json_in_text`. Модели ремонтную реплику не отправлять. В M1 нет второго шанса на той же модели: эскалация наружу — M2.
10. Исключение инструмента → шаг `tool_result` с `error`, строка ошибки уходит модели, цикл продолжается.
11. Шаги кончились без `final` → `finish(failed)`, `error = step_budget_exhausted`.

Температура запроса M1 — `0`. Поле `tools` в запросе — только отфильтрованный список, схема из zod. Для чата `coder-cloud` M3-P7 это поле убирает и добавляет `reasoning_effort: none`. Локальный алиас `agent` оба исключения не получает.

Потеря лока на heartbeat внутри цикла: немедленно выйти. `finish` не вызывать.

## 11. Инструменты M1

`read_file`. Аргумент `path` — относительный путь внутри `FILE_ROOT`. `realpath` обоих. Результат — текст до 64 КиБ. Каталог, бинарное содержимое, выход из корня, симлинк наружу — ошибка инструмента, не исключение процесса.

`list_dir`. Аргумент `path` необязательный, по умолчанию корень. Один уровень, имена и признак каталога, без рекурсии.

Оба `effect: "read"`. Оба без сети.

Корень в тестах — временный каталог. В локальном запуске — каталог из `FILE_ROOT`, по умолчанию `./workspace`, создаётся пустым, в gitignore.

## 12. HTTP

- `GET /health` без токена → `{ "ok": true }`.
- Остальное требует заголовок `Authorization: Bearer <HARNESS_API_TOKEN>`. Сравнение константное по времени.
- `POST /v1/runs`. Тело: `agent_slug`, `idempotency_key`, `message`, необязательный `chat_id`. Ответ 201 и `reason: created`, 200 и `reason: replay`, 409 и `reason: dialog_busy` вместе с id живого запуска. Неизвестный slug — 404.
- `GET /v1/runs/:id` — запуск и шаги по порядку `step_index`. Чужой `tenant` в M1 не возникает: все строки `local`, но фильтр `tenant_id = local` в запросе есть.

Тело ответа не содержит `DATABASE_URL` и заголовков авторизации.

## 13. Telegram

Один бот, один агент, slug из `AGENT_SLUG`.

- Пользователь не из `TELEGRAM_ALLOWED_USER_IDS` получает одну фразу отказа. Запуск не создаётся.
- Текст пустой, или сообщение без текста (файл, стикер) — ответ, что в этом срезе принимается только текст. Запуск не создаётся.
- Иначе `enqueue` с ключом `tg:{agentId}:{updateId}` и `chat_id`.
- `created` → сообщение «Запуск принят» и id.
- `replay` → тот же id, без второй строки в базе.
- `dialog_busy` → id живого запуска и фраза, что новый не создан.
- Дальше процесс раз в 2 секунды читает этот запуск, пока статус не конечный или не прошла 10 минут. `succeeded` → `final_text`. `failed` → короткая фраза и `error`, без стека. Повторная доставка того же текста не шлётся: в памяти процесса достаточно множества id уже отправленных итогов. Рестарт может отправить итог повторно. Устойчивая отметка доставки — M2, в план M1 не входит, агент её не добавляет.

Процесс Telegram не открывает LiteLLM.

## 14. Конфигурация

Файл `.env.example` без значений секретов.

| Переменная | Смысл | Значение M1 |
| --- | --- | --- |
| `DATABASE_URL` | рабочая база | Postgres `:5442`, база `harness` |
| `HARNESS_TEST_DATABASE_URL` | тесты | база `harness_test` |
| `LITELLM_BASE_URL` | шлюз | `http://127.0.0.1:4000/v1` |
| `LITELLM_API_KEY` | виртуальный ключ | из локального стека, не из репозитория |
| `HARNESS_API_TOKEN` | bearer API | человек генерирует сам |
| `TELEGRAM_BOT_TOKEN` | бот | пусто, пока процесс Telegram не нужен |
| `TELEGRAM_ALLOWED_USER_IDS` | список через запятую | пусто |
| `AGENT_SLUG` | агент бота | `clerk` |
| `FILE_ROOT` | тюрьма файлов | `./workspace` |
| `WORKER_ID` | метка лока | имя хоста, если не задано |
| `LEASE_SECONDS` | аренда | `120` |
| `HEARTBEAT_SECONDS` | период продления | `15` |
| `HARNESS_LIVE_MODEL` | живой прогон в P9 | не задан, тест пропускается |

## 15. Волны и пакеты

```text
Волна 0     P0
Волна 1     P1 ∥ P2 ∥ P3 ∥ P4
Волна 2     P5          P7 зависит только от P1, может стартовать вместе с P5
Волна 3     P6 зависит от P1 и P5
            P8 зависит от P1; сквозной ручной прогон ждёт P6
Волна 4     P9 после P6 P7 P8
            P10 после P9
```

P7 и P5 параллельны: API вызывает `enqueue` и чтение, раннер ему не нужен. P8 и P6 параллельны по той же причине. Сквозной сценарий «написал боту и получил ответ модели» входит в P9, не в P8.

### M1-P0. Каркас и контракты

- Волна: 0. Зависит от: ничего. Статус: `done`.
- Пути: корень репозитория (`package.json`, `tsconfig.json`, `vitest.config.ts`, `.nvmrc`, `.gitignore`, `.env.example`), `src/contracts/**`, `src/config.ts`, `src/db/client.ts`, `src/routing/resolve.ts`, `migrations/001_init.sql`, `seed/local_agent.sql`, `test/helpers/db.ts`, `test/contracts/**`, `test/routing/resolve.test.ts`.
- Сделать: проект Node 22 ESM, строгий TypeScript, vitest, скрипты `migrate`, `seed`, `test`, `api`, `worker`, `telegram`. Команды процессов могут указывать на файлы, которые появятся в следующих пакетах: в P0 достаточно, что `migrate` применяет SQL по порядку и повторный запуск ничего не дублирует. Таблица `schema_migrations(version text primary key)`. Клиент базы. `resolveModel` как в разделе 8. Контракты и чистая `interpretModelOutput`. Хелпер тестов падает, если имя базы не кончается на `_test`, и на каждом тесте очищает `run_steps`, `runs`, `agents`, затем заново применяет сид.
- Тесты: разбор четырёх веток `interpretModelOutput`; запрет побеждает allowlist на чистой функции фильтра имён; `resolveModel` возвращает поля агента; миграция дважды подряд оставляет одну копию таблиц; check принимает `source = cron` и не принимает произвольную строку.
- DoD: `npm test` зелёный без LiteLLM и без Telegram. В `package.json` нет запрещённых зависимостей. Паролей в файлах нет.
- Не делать: очередь, HTTP, бот, инструменты, клиент LiteLLM.

### M1-P1. Очередь

- Волна: 1. Зависит от: P0 `done`. Статус: `done`.
- Пути: `src/queue/**`, `test/queue/**`.
- Сделать: функции из раздела 8 ровно по SQL раздела 9.
- Тесты на `harness_test`, два реальных соединения там, где сказано:
  - повтор того же ключа не создаёт вторую строку и возвращает первую;
  - второй `chat_id` при живом запуске даёт `dialog_busy` и не создаёт строку;
  - тот же `chat_id` после `succeeded` создаёт новый запуск;
  - `chat_id = null` не включает блокировку диалога: два API-запуска с разными ключами оба создаются;
  - два соединения захватывают две разные строки, не одну;
  - порядок: меньший `priority` раньше, при равном — более ранний `created_at`;
  - `not_before` в будущем строка не захватывается;
  - просроченный `locked_until` возвращает строку в `queued`, `attempt` сохраняется, следующий захват увеличивает его ещё на 1;
  - при `attempt >= max_attempts` просрочка ставит `failed` и `error = lease expired`;
  - heartbeat чужого `workerId` возвращает `false` и не двигает `locked_until`;
  - `finish` чужого воркера возвращает `false` и оставляет `running`;
  - успешный `finish` виден второму захвату как отсутствие работы.
- DoD: все тесты выше зелёные. В коде захвата есть ровно один `for update skip locked`.
- Не делать: вызов модели, HTTP, Telegram.

### M1-P2. Инструменты

- Волна: 1. Зависит от: P0 `done`. Статус: `done`.
- Пути: `src/tools/**`, `test/tools/**`, `test/fixtures/**`.
- Сделать: реестр, фильтр allowlist с учётом запрета, `read_file`, `list_dir`, тюрьма `FILE_ROOT`.
- Тесты без базы:
  - чтение файла внутри корня;
  - `../` и абсолютный путь снаружи — ошибка, файл снаружи не прочитан;
  - симлинк на файл снаружи — ошибка;
  - файл больше 64 КиБ обрезается или возвращает ошибку лимита, одно из двух зафиксировать в тесте как обрезку с пометкой `truncated: true` в результате;
  - `list_dir` не спускается во вложенный каталог;
  - имя `Bash` в allowlist не попадает в список для модели;
  - неизвестное имя, которое модель «вызвала», функция политики отклоняет без `execute`.
- DoD: тесты зелёные, у обоих инструментов `effect: "read"`.
- Не делать: devmem, сеть, запись файлов.

### M1-P3. Клиент модели

- Волна: 1. Зависит от: P0 `done`. Статус: `done`.
- Пути: `src/model/**`, `test/model/**`.
- Сделать: `LiteLLMChatModel` реализует `ChatModel`. Запрос `POST {base}/chat/completions`, заголовок bearer, `temperature: 0`, `tools` из входа. Разбор ответа в `ModelOutput`: пустой массив, если поля `tool_calls` нет. Тело аргументов оставить строкой, не парсить здесь.
- Тесты: поднять локальный `http` сервер внутри теста, не LiteLLM. Проверить форму запроса и разбор трёх ответов: текст, один tool call, пустой choices. Ошибка HTTP становится исключением с кодом статуса, без тела, если тело содержит ключ из redact-списка. Для этого клиент прогоняет сообщение об ошибке через `redact`, а сам `redact` в P0 не живёт. Значит функция `redact` создаётся здесь, в `src/model/redact.ts`, и P4 её импортирует. Это единственное осознанное общее место волны 1. Путь `src/model/redact.ts` принадлежит P3. P4 импортирует, не редактирует.
- DoD: тесты на фиктивном сервере зелёные. Живой вызов `qwen` в этот пакет не входит.
- Не делать: цикл раннера, запись в базу.

### M1-P4. Журнал

- Волна: 1. Зависит от: P0 `done`. Статус: `done`. Импорт `redact` из P3: функция уже влита, копировать её нельзя.
- Пути: `src/journal/**`, `test/journal/**`.
- Сделать: `appendStep` со следующим `step_index` в транзакции (`select max + 1` при блокировке строк этого `run_id`). Выдержки обрезаются до 2000 символов и проходят `redact`. Токены пишутся как есть.
- Тесты на базе: два шага получают индексы 0 и 1; секрет из списка не встречается в `request_excerpt` и `response_excerpt`; параллельные вставки не ломают уникальность `(run_id, step_index)`.
- DoD: тесты зелёные.
- Не делать: формат ответа API. Чтение для HTTP напишет P7 через простой запрос в своём каталоге.

### M1-P5. Раннер

- Волна: 2. Зависит от: P2, P3, P4 `done`. Статус: `done`. Очередь используется через интерфейс, в тестах — фейковый heartbeat и finish.
- Пути: `src/runner/**`, `test/runner/**`.
- Сделать: `OpenAICompatRunner` по разделу 10. Модель и инструменты приходят снаружи, чтобы тест не поднимал сеть и файлы вне временного корня.
- Тесты:
  - финальный текст без инструментов → один `model_request`, один `final`, `finish(succeeded)`;
  - один `tool_call` `list_dir`, затем текст → инструмент вызван, в историю ушёл результат, затем `succeeded`;
  - `tool_call` с именем `Bash` → `policy_deny`, `execute` не вызван, модели ушёл отказ, следом финальный текст ещё может завершить запуск;
  - ответ `json_in_text` → `failed`, `execute` не вызван, `final_text` пустой;
  - пустой ответ → `failed`;
  - `max_steps = 2` и модель всё время зовёт инструмент → `failed`, `error = step_budget_exhausted`, вызовов модели ровно 2;
  - heartbeat вернул `false` перед вторым ходом → `finish` не вызван, второго `model_request` нет;
  - исключение инструмента видно модели на следующем ходу, процесс жив.
- DoD: тесты зелёные. В раннере нет импорта Hono и grammY.
- Не делать: реальный воркер, Telegram, второй шанс модели после `parse_error`.

### M1-P6. Воркер

- Волна: 3. Зависит от: P1 и P5 `done`. Статус: `done`.
- Пути: `src/worker.ts`, `test/worker/**`.
- Сделать: цикл один раз за итерацию: `reapExpired`, `claimNext`, если пусто — сон 1 секунда, если есть — `Runner` с heartbeat-таймером. `WORKER` не запускает второй `run`, пока первый не вернулся. Ошибка раннера, которая вылетела наружу, делает `finish(failed)` только если лок ещё наш, и цикл продолжается.
- Тесты на базе и фейковом `Runner`: две строки в очереди исполняются строго по одной; просроченная строка подхватывается следующим проходом; раннер, который падает исключением, не останавливает процесс, строка становится `failed`.
- DoD: тесты зелёные. В файле воркера нет второго параллельного `claim`.
- Не делать: пул воркеров, Telegram.

### M1-P7. HTTP

- Волна: 2, параллельно с P5. Зависит от: P1 `done`. Статус: `done`.
- Пути: `src/api/**`, `test/api/**`.
- Сделать: маршруты раздела 12. Чтение шагов — запрос в этом каталоге, без правки `src/journal`.
- Тесты через Hono `app.request`, база реальная:
  - без токена `POST` даёт 401, `GET /health` даёт 200;
  - неверный токен — 401;
  - постановка создаёт строку `queued`;
  - повтор ключа — 200 и тот же id;
  - живой диалог — 409 и id живого;
  - неизвестный slug — 404;
  - `GET` возвращает шаги по возрастанию индекса.
- DoD: тесты зелёные. В API нет импорта `ChatModel`.
- Не делать: веб-интерфейс, пользователей, refresh-токены.

### M1-P8. Telegram

- Волна: 3, параллельно с P6. Зависит от: P1 `done`. Статус: `done`.
- Пути: `src/telegram/**`, `test/telegram/**`.
- Сделать: разбор апдейта как чистая функция плюс тонкий адаптер grammY. Чистая функция решает: отказать, сказать что нужен текст, или вызвать `enqueue` с заданным ключом. Опрос статуса и текст исходящего сообщения тоже чистые функции от записи запуска, чтобы тест не говорил с Telegram.
- Тесты без сети Telegram:
  - чужой user id не вызывает `enqueue`;
  - файл не вызывает `enqueue`;
  - текст зовёт `enqueue` с ключом `tg:{agentId}:{updateId}`;
  - `dialog_busy` превращается в текст, где есть id живого запуска;
  - `succeeded` даёт исходящее с `final_text` один раз, повторный опрос того же состояния исходящего не даёт;
  - `failed` не включает стек, включает `error`.
- DoD: тесты зелёные. В каталоге нет импорта `src/model` и `src/runner`.
- Не делать: приём файлов, буфер сообщений на время занятости диалога, отметку доставки в базе.

### M1-P9. Приёмка

- Волна: 4. Зависит от: P6, P7, P8 `done`. Статус: `done`.
- Пути: `test/acceptance/**`, фикстуры внутри этого каталога. Продуктовые каталоги не менять. Если сценарий красный из-за продукта, отчёт оркестратору, пакет владельца получает `blocked` или возвращается в работу. Приёмка сама логику не чинит.
- Сценарии на `harness_test`. Модель везде фейковая, кроме последнего.
  1. Два соединения захватывают разные запуски.
  2. Убить владельца: выставить `locked_until` в прошлое при `running`, прогнать reaper и один цикл воркера с раннером, который падает, если его вызвали второй раз на уже `succeeded`. Ожидание: просроченный запуск либо снова исполняется, либо `failed` после исчерпания попыток, и никогда не становится вторым `succeeded`.
  3. Один и тот же `update_id` дважды через чистую функцию Telegram и `enqueue`: одна строка.
  4. Диалог занят: второй текст не создаёт строку.
  5. Модель вернула `Bash`: шага с исполнением нет, есть `policy_deny`.
  6. Модель вернула JSON инструмента в `content` и пустые `tool_calls`: статус `failed`, `final_text` пуст, инструмент не вызван.
  7. Результат инструмента содержит фейковый токен: в `run_steps` и в сообщениях, которые тестовая модель получила вторым ходом, токена нет.
- Живой прогон, только если `HARNESS_LIVE_MODEL=1` и алиас `agent` отвечает на шлюзе: `FILE_ROOT` с одним текстовым файлом, постановка «прочитай файл и назови его содержимое». Ожидание: есть шаг `tool_call` с именем `read_file` и статус `succeeded`. Нет зелёного требования к красоте формулировки. Если живой прогон красный, это наблюдение в отчёте, не повод менять фейковые тесты. Оркестратор решает, блокер это M1 или известный предел модели.
- DoD: семь сценариев зелёные. Живой прогон либо зелёный, либо явно пропущен без флага.
- Не делать: новые возможности, чтобы сценарий прошёл.

### M1-P10. Документация запуска

- Волна: 4. Зависит от: P9 `done`. Статус: `done`.
- Пути: `README.md`, `docs/runbook.md`.
- Сделать: как создать две базы, какие процессы поднять, как прогреть алиас `agent` командами уже существующего Local-AI-dev-stack, как послать `POST /v1/runs`, как включить бота, какие порты нельзя занимать (`3000`, `5432`, `5442`, `4000`, `8765` и остальные из README стека). Коротко: M1 не проводит платежи и не ходит в 1С. Ограничение одно предложение, без дорожной карты на пол-README: M2 и M3 описаны здесь, в плане.
- DoD: по README человек поднимает API и воркер без устных дополнений. Секретов в тексте нет.
- Не делать: правки кода, кроме комментария запуска, если без него команда из README не существует. Такой пробел — блокер соответствующему пакету, не самодеятельность в README.

## 16. M2. Локально и внешние

Не начинать, пока M1-P9 не `done`. Пакеты M2 оркестратор дробит отдельным дополнением этого файла. Здесь только швы, чтобы M1 их не заварил.

M2-A. Маршрут. Таблица `route_rules` добавляется новой миграцией, не правкой `001`. `resolveModel` начинает её читать. Правила: инструмент с `effect: "write"` и второй `parse_error` за сутки по агенту выбирают внешний алиас. Первый ход чтения остаётся локальным. На запуске и в шаге видно, какой алиас ответил. Стоимость: колонка `cost_usd` в `run_steps`, для `local` пишется 0, для внешнего берётся из ответа LiteLLM, если поле есть, иначе `null` и шаг всё равно пишется.

M2-B. Включение внешнего алиаса — конфигурация LiteLLM в репозитории Local-AI-dev-stack (`OPENROUTER_API_KEY`, модель, fallback). В HARNESS появляется только алиас в правиле маршрута. Второй HTTP-клиент не пишется.

M2-C. Инструмент с побочным эффектом. Первый такой инструмент — не банк. Это `record_note`: пишет файл в `FILE_ROOT/out` с ключом идемпотентности вызова. Повтор того же ключа возвращает первый результат и не создаёт второй файл. На этом учебном инструменте закрепляется контракт, который потом наденут на 1С. Настоящих ключей магазинов в M2 нет.

M2-D. Делегирование. Инструменты менеджера `create_subtask` и `approve`. `create_subtask` делает `enqueue` с `parent_run_id` и `source = delegation`. Менеджер не получает сырой токен чужого бота. Дочерний запуск исполняет тот же воркер. `approve` только переводит родительскую задачу. Таблица задач может появиться здесь. В M1 её нет намеренно.

M2-E. Кроны. Таблица `cron_jobs`: вид `script` или `agent`, выражение расписания, пауза. Скрипт — процесс без модели, из allowlist команд, не произвольный shell. Вид `agent` ставит запуск. Повторный тик при живом запуске этого крона пропускается. Три провала подряд ставят паузу и пишут сообщение в Telegram-чат из конфигурации крона. Джиттер — случайная задержка до 15 секунд перед постановкой, чтобы два крона одной минуты не ударили в карту одновременно.

M2-F. Буфер диалога и отметка доставки. Сообщение, пришедшее в занятый чат, сохраняется и ставится в очередь после финиша живого запуска, одно за раз. Это замена отказа `dialog_busy` для Telegram. HTTP по-прежнему может получать 409: буфер — поведение бота.

Порядок M2: A и B вместе, затем C, затем D и E параллельно разными путями, F после E. Приёмка M2 повторяет семь учений M1 и добавляет: запись `record_note` дважды с одним ключом создаёт один файл; `parse_error` на локальной модели следующий запуск того же хода делает внешним алиасом на фейковом клиенте; крон `script` не открывает `ChatModel`.

Пакеты ниже — это дробление швов. Код M2 пишет исполнитель только своего пакета. `001_init.sql` не переписывается. Новая колонка — новый файл миграции.

```text
M2-0   P1
M2-1   P2 после P1
M2-2   P3, затем P4
M2-3   P5 после P4
M2-4   P6 после P2, P3, P4, P5
```

### M2-P1. Маршрут и внешний алиас

- Волна: M2-0. Зависит от: M1-P10 `done`. Статус: `done`. Это единственный пакет M2, которому можно менять контракт, и только полями ниже.
- Пути: `migrations/002_route.sql`, `src/routing/**`, `src/contracts/**`, `src/runner/**`, `src/model/litellm.ts`, `src/model/index.ts`, `test/routing/**`, `test/runner/**`, `test/model/**`, `seed/route_rules.sql`.
- Сделать: новая миграция, не правка `001`. Таблица `route_rules(id uuid primary key, tenant_id text not null, agent_id uuid not null references agents(id), kind text not null check (kind in ('write_tool','second_parse_error')), model_alias text not null, provider text not null check (provider = 'external'))`. Колонка `run_steps.cost_usd numeric`. `resolveModel` читает правила. Инструмент с `effect: "write"` и второй `parse_error` за сутки по этому агенту выбирают внешний алиас из правила. Первый ход чтения остаётся локальным. На запуске и в шаге видно, какой алиас ответил. Для `provider = local` в шаг пишется `cost_usd = 0`. Для внешнего берётся число из ответа LiteLLM, если поле есть, иначе `null`, и шаг всё равно пишется. Алиас в сиде правила — `coder-cloud`: это имя уже намечено в конфиге стека и в HARNESS только строка правила. Второй HTTP-клиент не пишется. Репозиторий стека не менять.
- Тесты на фейковом клиенте, без живого OpenRouter: ход чтения остаётся `agent` / `local` и пишет `cost_usd = 0`; вызов инструмента `effect: "write"` выбирает `coder-cloud` / `external`; второй `parse_error` за сутки по агенту на следующем запуске того же хода выбирает внешний алиас; первый `parse_error` остаётся локальным; ответ без поля стоимости пишет шаг с `cost_usd is null`.
- DoD: тесты зелёные. `001_init.sql` не изменён. Второго клиента модели нет.
- Не делать: правку LiteLLM в Local-AI-dev-stack, `record_note`, кроны, делегирование.

### M2-P2. Учебная запись

- Волна: M2-1. Зависит от: M2-P1 `done`. Статус: `done`.
- Пути: `src/tools/record-note.ts`, регистрация в `src/tools/registry.ts` и `src/tools/index.ts`, `test/tools/record-note.test.ts`.
- Сделать: инструмент `record_note`, `effect: "write"`. Пишет файл в `FILE_ROOT/out` с ключом идемпотентности вызова. Повтор того же ключа возвращает первый результат и не создаёт второй файл. Ключей магазинов нет.
- Тесты: два вызова с одним ключом — один файл и тот же результат; другой ключ — второй файл; путь вне `FILE_ROOT/out` — ошибка инструмента.
- DoD: тесты зелёные. `effect` именно `write`.
- Не делать: настоящий коннектор 1С, сеть.

### M2-P3. Делегирование

- Волна: M2-2. Зависит от: M2-P2 `done`. Статус: `done`. Параллельно с P4 по смыслу, но P4 стартует после этого пакета: постановка `source = cron` появляется здесь же.
- Пути: `migrations/003_tasks.sql`, `src/delegation/**`, `test/delegation/**`, `src/contracts/types.ts` только поля постановки, `src/queue/run-queue.ts` только запись этих полей.
- Сделать: инструменты менеджера `create_subtask` и `approve`. `create_subtask` делает `enqueue` с `parent_run_id` и `source = delegation`. В `EnqueueInput` добавь необязательный `parentRunId` и разреши источнику `delegation` и `cron`. Очередь пишет их в уже существующие колонки и больше ничего в захвате не меняет. Менеджер не получает сырой токен чужого бота. Дочерний запуск исполняет тот же воркер. `approve` только переводит родительскую задачу. Таблица задач появляется здесь.
- Тесты: дочерняя строка имеет `parent_run_id` и `source = delegation`; повтор того же ключа не создаёт вторую; `approve` не вызывает модель и не читает токен бота.
- DoD: тесты зелёные. Очередь не импортирует клиент модели.
- Не делать: кроны, буфер Telegram, правку `001`.

### M2-P4. Кроны

- Волна: M2-2. Зависит от: M2-P3 `done`. Статус: `done`. Стартует после P3, потому что источник `cron` добавляет постановка P3.
- Пути: `migrations/004_cron.sql`, `src/cron/**`, `test/cron/**`.
- Сделать: таблица `cron_jobs`: вид `script` или `agent`, выражение расписания, пауза, чат Telegram для сообщения о паузе. Скрипт — процесс без модели, команда из allowlist, не произвольный shell. Вид `agent` ставит запуск. Повторный тик при живом запуске этого крона пропускается. Три провала подряд ставят паузу и готовят текст сообщения в Telegram-чат из конфигурации крона. Отправку в живой Telegram не делать: тест проверяет текст и факт паузы. Джиттер — случайная задержка до 15 секунд перед постановкой.
- Тесты: `script` не открывает `ChatModel`; второй тик при живом запуске не создаёт строку; третий провал ставит паузу; команда вне allowlist не запускается.
- DoD: тесты зелёные. `child_process` со строкой оболочки нет.
- Не делать: делегирование, буфер диалога, правку `001`.

### M2-P5. Буфер диалога

- Волна: M2-3. Зависит от: M2-P4 `done`. Статус: `done`.
- Пути: `migrations/005_dialog_buffer.sql`, `src/telegram/**`, `test/telegram/**`.
- Сделать: сообщение в занятый чат сохраняется и ставится в очередь после финиша живого запуска, одно за раз. Для Telegram это замена отказа `dialog_busy`. HTTP по-прежнему может получать 409. Устойчивая отметка доставки итога пишется здесь, не только в памяти процесса.
- Тесты: второй текст при живом запуске не создаёт вторую строку сразу и создаёт одну после финиша; HTTP `dialog_busy` остаётся 409; повторная доставка того же итога не готовится второй раз после перезапуска процесса.
- DoD: тесты зелёные. Каталог Telegram не импортирует модель и раннер.
- Не делать: приём файлов, кроны.

### M2-P6. Приёмка M2

- Волна: M2-4. Зависит от: M2-P2, M2-P3, M2-P4, M2-P5 `done`. Статус: `done`.
- Пути: `test/acceptance/m2.test.ts` и фикстуры рядом. Продуктовые каталоги не менять.
- Сделать: семь учений M1 остаются зелёными. Плюс: `record_note` дважды с одним ключом создаёт один файл; `parse_error` на локальной модели следующий запуск того же хода делает внешним алиасом на фейковом клиенте; крон `script` не открывает `ChatModel`.
- DoD: эти проверки зелёные. Красный продуктовый сценарий не чинить, вернуть владельцу пакета.
- Не делать: новые возможности, чтобы сценарий прошёл.

## 17. M3. Внешний контур

Не начинать до приёмки M2. Пакеты ниже ждут `done` у M2-P6. Код M3 до этого не пишется.

### M3-P1. ClaudeSdkRunner

- Волна: M3-0. Зависит от: M2-P6 `done`. Статус: `done`.
- Пути: `src/runner/claude-sdk.ts`, выбор реализации в `src/worker.ts`, `test/runner/claude-sdk.test.ts`.
- Сделать: `ClaudeSdkRunner` реализует тот же `Runner`. Воркер выбирает реализацию по `provider`, который вернул `resolveModel`. SDK не импортируется из очереди, API и Telegram. Зависимость SDK в M1 закрытом списке запрещена: пакет останавливается `blocked`, если её нет в плане отдельным разрешением оркестратора. До этого разрешения тесты идут на подставном объекте с тем же интерфейсом, без установки SDK.
- Тесты: `provider = local` не создаёт SDK-раннер; `provider = external` выбирает вторую реализацию; очередь, API и Telegram этот модуль не импортируют.
- DoD: тесты зелёные. Импорта SDK из очереди, API и Telegram нет.
- Не делать: контейнер, админку, установку SDK без разрешения в этом плане.

### M3-P2. Контейнер на запуск

- Волна: M3-1. Зависит от: M3-P1 `done`. Статус: `done`.
- Пути: `src/runner/sandbox.ts`, `test/runner/sandbox.test.ts`.
- Сделать: у процесса запуска нет домашнего каталога пользователя. Из сети доступен только шлюз модели и явно перечисленные MCP. Встроенные Bash, Read, Write, Edit в политику SDK не включаются. Список запрета M1 остаётся.
- Тесты: политика не содержит этих имён; цель сети вне шлюза и перечисленного MCP отклоняется без вызова.
- DoD: тесты зелёные.
- Не делать: настоящий выход в чужой домашний каталог, админку.

### M3-P3. Секреты коннекторов

- Волна: M3-1. Зависит от: M2-P2 и M2-P6 `done`. Статус: `done`. Параллельно с P2, пути не пересекаются.
- Пути: `migrations/006_connector_secrets.sql`, `src/secrets/**`, `test/secrets/**`.
- Сделать: шифрование на ключе из окружения, связь «секрет доступен агенту или отделу», в журнал попадает маска. Инструмент получает секрет внутри процесса коннектора. Ключ в репозиторий не пишется.
- Тесты: в шаге нет открытого секрета; повтор выдачи той же связи не создаёт вторую запись; без связи инструмент секрет не получает.
- DoD: тесты зелёные. Секрета в фикстуре, похожего на настоящий ключ, нет.
- Не делать: настоящие ключи магазинов, админку.

### M3-P4. Админка

- Волна: M3-2. Зависит от: M2-P6 `done`. Статус: `pending`.
- Пути: `web/**`. Каталога сейчас нет.
- Сделать: отдельный фронтенд на уже стабильном API запусков, шагов, агентов и кронов. Десять экранов из вакансии не начинать, пока оркестратор отдельным абзацем этого файла не назовёт зависимости фронтенда. До этого пакет `pending`, исполнитель его не берёт.
- Тесты и DoD будут в том абзаце. Сейчас их нет намеренно.
- Не делать: начинать экраны заранее, добавлять npm-зависимости в корневой `package.json`.

### M3-P5. Только внешние

- Волна: M3-2. Зависит от: M2-P6 `done`. Статус: `done`.
- Пути: `seed/external_only.sql`, `test/routing/external-only.test.ts`.
- Сделать: набор `route_rules` без локального алиаса. Код локального раннера остаётся. Тесты M1 продолжают идти на фейковой модели.
- Тесты: при этом наборе `resolveModel` не возвращает локальный алиас; `npm test` пакета M1 остаётся зелёным.
- DoD: оба прогона зелёные.
- Не делать: удаление локального раннера.

### M3-P6. Выбор модели в чате

- Волна: M3-3. Зависит от: M3-P1 и M3-P5 `done`. Статус: `done`.
- Пути: `migrations/007_chat_model.sql`, `src/telegram/**`, `src/worker.ts`, `src/runner/openai-compat.ts`, `test/telegram/**`, `test/runner/**`.
- Сделать: пользователь из allowlist пишет отдельным сообщением `/local` или `/cloud`. Команда не создаёт запуск и не вызывает модель. Процесс Telegram отвечает сам: на `/local` — «Этот чат спрашивает локальную модель.», на `/cloud` — «Этот чат спрашивает внешнюю модель.» Выбор хранится по `(tenant_id, chat_id)` и повтор команды обновляет ту же строку. Пока выбора нет, обычный текст идёт в алиас агента `agent`. После `/local` ход модели получает алиас `agent`, после `/cloud` — `coder-cloud`. Оба хода выполняет уже существующий OpenAI-совместимый раннер. `provider` захвата остаётся `local`: выбор чата не создаёт ClaudeSdkRunner. Внешний ответ — это алиас LiteLLM, не SDK. API, cron и delegation таблицу выбора не читают. Инструменты allowlist агента остаются при обоих выборах. Клиент воркера ждёт ответ LiteLLM 10 минут по собственному сокету: встроенный fetch обрывает заголовки через 5 минут и прячет уже идущий ответ. Бот ждёт итог на минуту дольше. Живой вызов Gemini, OpenRouter и Ollama не делать.
- Миграция `007_chat_model.sql` этим пакетом разрешена. Новая таблица `chat_model_choices(tenant_id text, chat_id bigint, model_alias text check (model_alias in ('agent', 'coder-cloud')), updated_at timestamptz, primary key (tenant_id, chat_id))`. Колонку в `src/contracts` не добавлять: воркер читает выбор и передаёт алиас в раннер.
- Тесты на фейковом клиенте: `/cloud` и `/local` не создают `runs` и пишут названный алиас; чужой пользователь получает отказ и строку не пишет; текст без выбора зовёт `agent`; текст после `/cloud` зовёт `coder-cloud` при `provider = local`; API-запуск выбор чата не читает.
- DoD: эти тесты зелёные. Каталог Telegram не импортирует клиент модели и Claude SDK. Временной переменной, которая отправляет весь Telegram во внешний алиас, в коде нет.
- Не делать: кнопки, админку, установку SDK, правку `seed/external_only.sql`, второй HTTP-клиент, живой запрос к Gemini. Инструменты на внешнем чате и предел размышления снимает M3-P7, этот пакет их не трогает.

### M3-P7. Внешний чат без инструментов и с минимальным размышлением

- Волна: M3-4. Зависит от: M3-P6 `done`. Статус: `ready`.
- Пути: `src/runner/openai-compat.ts`, `src/model/litellm.ts`, `src/contracts/types.ts`, `test/runner/**`, `test/model/**`.
- Зачем: один вопрос про модели картинок ушёл в `coder-cloud` тремя вызовами за 4 минуты 24 секунды. Модель открыла каталог, прочитала постороннюю заметку и только третьим вызовом написала ответ. Вопрос файлов не касался. Системный промпт клерка требует ответ по результатам инструментов, поэтому внешняя модель тратит отдельные вызовы на `list_dir` и `read_file`.
- Сделать, инструменты: если выбор чата подставил алиас `coder-cloud`, в этот ход список инструментов пуст. Ключ `tools` в JSON запроса не писать: пустой массив тоже предлагает модели вызвать инструмент. К системному промпту этого хода добавить одну фразу: «В этом ходе инструментов нет. Ответь на вопрос сразу, не открывая файлы.» Строку агента и промпт локального хода не менять. Вызов модели ровно один. Если в ответе есть `tool_calls`, запуск `failed` без второго вызова: суточный лимит внешней модели не тратить на продолжение. Алиас `agent`, запуск без выбора, API, cron и delegation список инструментов не теряют.
- Сделать, размышление: в тот же запрос `coder-cloud` добавить `reasoning_effort` со значением `none`. Установленный LiteLLM для Gemini 3 Flash переводит его в `thinkingConfig.thinkingLevel = minimal` и `includeThoughts = false`: ниже этого уровня модель не опускается, а ход мыслей в текст ответа не кладётся. Числовой `thinkingBudget` не использовать, это параметр Gemini 2.5. Алиас `agent` поле `reasoning_effort` не получает. Если шлюз отвергает поле, пакет останавливается и пишет `blocked`, поле молча не выбрасывать.
- Контракт: этому пакету можно добавить в `ModelInput` необязательное поле `reasoningEffort` со значением `none` или отсутствием. Других полей и колонок не добавлять.
- Тесты на фейковом клиенте, без живого Gemini, OpenRouter и Ollama: после `/cloud` клиент получает один вызов, без ключа `tools`, с `reasoning_effort: none` и с добавленной фразой промпта; `tool_calls` в этом ответе дают `failed` и второго вызова нет; после `/local` уходят `read_file` и `list_dir`, а `reasoning_effort` нет; API-запуск ведёт себя как раньше.
- DoD: эти тесты зелёные. Локальный allowlist в сиде не изменён. Живого запроса к Gemini нет.
- Не делать: кнопки, админку, SDK, правку `seed/external_only.sql`, смену промпта в строке агента, `reasoning_effort` для `agent`, числовой бюджет размышления, второй вызов внешней модели в том же запуске.

## 20. Картинки

Один шлюз рисует и правит. Telegram — первый клиент. Чат TaskFlow — второй, тем же HTTP, без второй установки ComfyUI и без второй копии весов. Языковая модель картинку не вызывает: ни локальная, ни Gemini. Иначе один вопрос снова займёт несколько вызовов и видеокарту.

Сейчас в чате TaskFlow ответ — строка `response`. Вложение чата — документ для разбора, не картинка сообщения. Telegram принимает только текст и отвечает `sendMessage`. Оба ограничения снимают пакеты ниже, не попутная правка.

Модель этого среза — FLUX.2 [klein] 4B distilled, лицензия Apache 2.0. Одна архитектура и для текста, и для правки по одному изображению. На карте 16 ГБ опубликованный шаблон ComfyUI занимает около 8,4 ГБ. Дистиллированный ход — 4 шага. Файлы ровно эти:

- `ComfyUI/models/diffusion_models/flux-2-klein-4b-fp8.safetensors`
- `ComfyUI/models/text_encoders/qwen_3_4b.safetensors`
- `ComfyUI/models/vae/flux2-vae.safetensors`

Источник диффузии — карточка `black-forest-labs/FLUX.2-klein-4B` и файл fp8 из шаблона ComfyUI. Кодер и VAE — файлы того же шаблона Klein 4B. Перед записью на диск пакет читает лицензию диффузионного файла. Это не Apache 2.0 — остановка `blocked`, файл не сохраняется. Klein 9B и FLUX.2 Dev не коммерические и в 16 ГБ целиком не встают: их не скачивать. Qwen-Image и отдельную модель правки Qwen в этот срез не качать: полный стек на эту карту не садится так, как Klein 4B. Сравнение качества — позже, отдельным абзацем.

ComfyUI уже стоит в `/home/santera/ComfyUI`, версия 0.44.0, узлы Flux2 в дереве есть, каталоги моделей пустые. Процесс ComfyUI не держать включённым. Порт шлюза `127.0.0.1:8190`. ComfyUI на время задания слушает только `127.0.0.1:8188`. Не занимать 11434, 4000, 5442, 8765 и 3001: 8765 уже занят devmem.

Порядок одного задания, его пишет шлюз, не человек руками на каждый запрос:

1. Взять исключительную блокировку. Вторая просьба получает `busy` и ComfyUI не запускает.
2. Записать имена из `ollama ps`. Каждую остановить через `ollama stop` и дождаться пустой таблицы. Не получилось освободить — ComfyUI не стартовать, языковые модели поднять обратно.
3. Запустить `/home/santera/ComfyUI/.venv/bin/python main.py --listen 127.0.0.1 --port 8188 --disable-auto-launch` из каталога ComfyUI.
4. Отправить замороженный граф официального шаблона Klein 4B distilled: генерация или правка по одному изображению. Граф не сочинять по памяти. В запрос подставляются только текст, seed и, для правки, файл. Дистиллированный режим: 4 шага, без отрицательного промпта. Генерация — 1024×1024. Правка — длинная сторона 1024, обе стороны кратны 16.
5. Дождаться PNG. Затем попросить ComfyUI выгрузить модели и остановить его процесс.
6. В `finally` поднять ровно записанные имена Ollama с `keep_alive: -1`, тем же приёмом, что `ollama/warmup.sh`. Список был пуст — память не занимать новой дежурной моделью. Профиль `coder`/`agent` из-за картинки не переключать.

Живой рисунок в тесты пакетов не входит. Проверка рукой — в конце M4-P2, один раз, когда человек попросит.

### M4-P1. Шлюз картинок

- Волна: M4-0. Зависит от: ничего в коде M3. Статус: `pending`. В `ready` переводит оркестратор, когда человек просит реализовать картинки. Пока M3-P7 не `done`, ближайший пакет текста — он. После его `done` ближайший пакет текста — M5-P1. Картинки M5-P1 не ждут и его не задерживают.
- Пути: `/home/santera/dev-ai-stack/image/**`, три названных файла весов в `/home/santera/ComfyUI/models/**`, два JSON графа рядом со шлюзом. Код ComfyUI, HARNESS и TaskFlow не менять.
- Сделать: HTTP на `127.0.0.1:8190`. `POST /v1/images` с полями `mode` (`generate` или `edit`), `prompt`, для правки — PNG или JPEG. Ответ: `id`, `status` (`succeeded`, `busy`, `failed`), короткий `error`, `media_type`, PNG. Промпт длиннее 1000 символов и картинка больше 8 МБ — `failed` без запуска ComfyUI. Нет трёх файлов весов — `failed` с устойчивым кодом `weights_missing`, процесс не стартовать. Занятая блокировка — `busy`. Журнал шлюза хранит id, режим, seed и код ошибки, не промпт и не байты картинки.
- Тесты без видеокарты и без скачивания: второй вызов при удержанной блокировке — `busy`; отсутствующие веса — `weights_missing` и процесс не создаётся; оба графа ссылаются на `flux-2-klein-4b-fp8.safetensors` и не ссылаются на `klein-9b` и `flux2-dev`; список восстановления Ollama равен списку, записанному до остановки.
- DoD: эти тесты зелёные. Лицензия диффузионного файла проверена до сохранения, в отчёте одна строка: имя файла и лицензия. Других весов на диске от этого пакета нет.
- Не делать: живой рисунок в тесте, Klein 9B, FLUX.2 Dev, Qwen-Image, постоянный процесс ComfyUI, вызов из раннера языковой модели, правку TaskFlow и Telegram.

### M4-P2. Картинка в Telegram

- Волна: M4-1. Зависит от: M4-P1 `done`. Статус: `pending`, пока P1 не `ready`.
- Пути: `src/telegram/**`, `test/telegram/**`. Шлюз и ComfyUI не переписывать.
- Сделать: сообщение `/image` и дальше текст — генерация. Ровно `/image` без текста отвечает «Напиши, что нарисовать.» и шлюз не вызывает. Фото с подписью, которая начинается с `/edit `, или ответ `/edit ` на фото — правка этого фото. `/edit` без фото отвечает «Пришли фото с подписью /edit и что изменить.» Другой файл по-прежнему получает «В этом срезе принимается только текст.» Команды не создают строку `runs` и не вызывают LiteLLM. Ответ картинки — `sendPhoto`. Подпись обычным текстом, без разметки, со seed. `busy` — «Картинка уже рисуется.» Пока шлюз занят этим чатом, процесс бота ждёт фото и не начинает второй рисунок.
- Тесты на фейковом шлюзе: `/image кот` один раз вызывает `generate` и не пишет `runs`; `/image` без текста шлюз не зовёт; фото без `/edit` остаётся отказом «только текст»; `/edit` без фото шлюз не зовёт; PNG фейка уходит в `sendPhoto`; `busy` не делает второй вызов.
- DoD: тесты зелёные. Каталог Telegram не импортирует ComfyUI, LiteLLM и Claude SDK.
- Не делать: кнопки, несколько исходных фото, живой Gemini, живой рисунок в тесте. Ручной прогон человек делает отдельно: одна генерация и одна правка, затем `ollama ps` показывает те же имена, что до команды.

### M4-P3. Тот же шлюз в чате TaskFlow

- Волна: M4-2. Зависит от: M4-P1 `done`. Статус: `pending`. Исполнитель HARNESS этот пакет не берёт: пути лежат в `/home/santera/Projects`.
- Пути будущего пакета: `backend/app/services/` для клиента шлюза, модель сообщения чата, виджет сообщения на странице чата, тесты клиента. Индексацию документов и RAG не трогать.
- Сделать, когда пакет откроют отдельно: команда чата TaskFlow зовёт тот же `POST http://127.0.0.1:8190/v1/images`. В сообщении ассистента остаётся короткий текст, а картинка лежит в `metadata` и показывается под ответом. В коллекцию `documents` и в источники RAG она не попадает. Чат по-прежнему не решает сам, какую карту занять: это делает шлюз.
- Тесты: клиент на фейковом шлюзе; `busy` и `weights_missing` видны в чате; исход сообщения не становится документом бакета.
- DoD будет в том задании. Сейчас пакет закрыт намеренно.
- Не делать: второй ComfyUI, другие веса, вызов картинки из RAG-промпта, реализацию из чата HARNESS.

Мультиарендность сверх колонки `tenant_id`: настоящие пользователи, биллинг и маркетплейс навыков в этот план не входят. Когда до них дойдёт очередь, пишется новый документ. Колонку не выкидывать.

Коннекторы почты, Jira, календаря и браузера этим файлом не открываются и кода не получают, пока оркестратор не заведёт под них отдельные пакеты после сейфа секретов. Контракт заранее тот же, что у `record_note`: имя инструмента, allowlist конкретного агента, ключ идемпотентности на побочный эффект. Секрет забирает помощник коннектора, модель его не видит и не выбирает, кому он доступен.

Почта, Jira и календарь опрашивает крон вида `script`, без модели. Запуск с моделью ставится, когда появилось письмо, событие календаря или текст из Telegram. Менеджер раздаёт работу через `create_subtask`: у каждого источника свой агент. Браузер — помощник на включённом компьютере пользователя. Он сообщает открытую вкладку или выполняет заранее названное действие. Поиск по экрану моделью не делается. Пока компьютер выключен, этого источника нет.

На одной видеокарте модели идут по очереди. Этот абзац не пакет и кода не открывает. Когда гостя нет, в памяти одна дежурная `qwen3.5:9b`: почта, Jira, наблюдение и выбор маршрута. Маршрут читается по списку инструментов дежурного агента, не по одному слову-метке. Дообучение не начинать, пока провал остаётся после правки промпта и этого списка. Гость занимает карту целиком и дорабатывает до конца: его не вытесняют, девятку рядом не держат и `num_gpu` карту не делит. Сложный разбор и рассуждение по уже принесённому тексту идут на `qwen3.8:latest`. Код и смешанная задача «понять и поправить код» идут на `qwen3-coder`. Картинки — тоже гость, не дежурная модель: FLUX.2 Klein 4B из M4 грузится только на время одного рисунка и после него снимается. Пока гость загружен, девятки в памяти нет, почта и Jira ждут в очереди. После финиша гость выгружается, девятка возвращается. Поиск в интернете делает отдельный инструмент и приносит текст. Большая модель только рассуждает по этому тексту.

## 21. Вызов сервиса и отчёт

Один пакет. Отдельный пакет «только таблицы» не заводить. Поля конверта, null, SQL и отказы — в `docs/spec/09-tool-v2.md`. Исполнитель оттуда не выдумывает вторую форму.

Отчёт едет в ответе того `POST /v1/tools/{name}`, который отправил хаб. Callback, webhook и входящий маршрут приёма отчёта не добавлять. На провод уходит только `harness.tool.v2`. Разбор v1 в `contract/` и в `src/runner/tool-result-text.ts` остаётся закрытым и на провод не ставится.

### M5-P1. Вызов сервиса и отчёт

- Волна: M5-0. Зависит от: M3-P7 `done`. Статус: `pending`.
- Ворота: выдавать, когда M3-P7 `done` и его `exclusive_paths` свободны. Параллельно с M3-P7 не выдавать: оба пишут `src/runner/openai-compat.ts`. M4 не ждать. Репозиторий `harness-files` не клонировать и не начинать до `done` этого пакета.
- Ветка: `m1/m5-p1-service-report`. Схема веток репозитория — `m1/<id>`, отдельный префикс `m5/` не заводить.
- Пути: `migrations/012_service_reports.sql`, `src/services/**`, `src/runner/openai-compat.ts` (только ветка вызова; пустой список `coder-cloud` и `reasoning_effort` не снимать), `src/worker.ts` (уборка в уже существующем `runIteration`), `src/config.ts` (путь манифеста, сумма, секрет по имени из манифеста), `.env.example` (пустые `SERVICES_MANIFEST` и `SERVICES_MANIFEST_SHA256`), `test/services/**`, `test/helpers/db.ts` (только `delete` новых таблиц до `run_steps`).
- Нельзя: `src/queue/**` — очередь клиент сервиса не импортирует (**I1**). `src/api/**` — `GET /v1/runs/:id` отчёт не отдаёт. `src/contracts/**` — `STEP_KINDS` не менять. `src/model/**`, `src/journal/**`, `src/tools/**`, `src/telegram/**`, `src/cron/**`, `src/runner/tool-result-text.ts`, `src/runner/claude-sdk.ts`, `contract/**`, `web/**`. Миграции `001`…`011`. Колонку `run_steps.duration_ms`. `parent_run_id` для вызова сервиса. Статусы этого файла.
- Инварианты: **I1** клиент живёт в `src/services/**`, его импортируют раннер и воркер, не очередь. **I4** `redact` до выдержки, до jsonb и до следующего сообщения модели; в роль `tool` входит подготовленный `text` или строка `error`, не `report`. **I7** обновление поручения только пока запуск `running` и `locked_by` этот воркер; ноль строк — `finish` не вызывать и `succeeded` не ставить; потеря heartbeat не ставит поручению `completed`; reaper `succeeded` не ставит. **I12** локальные инструменты M1 сеть не получают; HTTP делает клиент после коммита захвата. **I13** один воркер — один запуск; повтор транспорта того же тела второй запуск не открывает. **I15** зависимости не добавлять. **I17** разрешён один новый файл `012_service_reports.sql`; остальные миграции и `src/contracts/**` не трогать. **I20** секрет сервиса в журнал и в модель не входит.
- Миграция: последний файл на диске — `008_completion_limit.sql`. `009_model_slots.sql` и `010_blobs.sql` уже названы в `docs/spec/03-slots-and-workers.md` и `docs/spec/05-files.md`, файлов нет, эти номера не занимать. `011_step_duration.sql` не создавать. Таблицы — `migrations/012_service_reports.sql`, схема из `09-tool-v2.md`: `service_invocations`, `service_results`, `service_model_steps`. Колонки заявлений называются `claimed_*`.
- Сделать: клиент, разбор v2 и таблицы одним заданием, ровно по `09-tool-v2.md`. Пустая `SERVICES_MANIFEST` HTTP не включает и локальные инструменты не выключает. Заданный манифест читается через `parseServicesManifest`, адрес берётся только из него, `redirect: "error"`. Имя из манифеста при ошибке сети локальным `execute` не подменяется. Строка `pending` коммитится до fetch. Таймаут чтения 30 с, таймаут записи 60 с. Уборку `pending` → `abandoned` и снятие jsonb старше 30 суток пачками не больше 20 строк вызывает `runIteration` после `reapExpired` и до `claimNext`. Крон не заводить. `src/services/**` сам `process.env` не читает.
- Тесты: `test/services/service-call.test.ts` на `harness_test`. Фейковый HTTP внутри теста. Модуль `postgres` не мокать. `it.skip` не оставлять. Имена:
  - должен принять сервис без модели и записать `has_model: false`;
  - должен принять сервис со следом и записать шаги;
  - должен оставить колонки заявлений отчёта пустыми, когда ключа `report` нет, и записать `claimed_duration_ms` из конверта;
  - должен отдать годный `text` в модель при битом `report`, поставить `report_status = invalid` и не заклинить идемпотентность;
  - должен отвергнуть чужой `nonce` и не привязать тело ни к какому запуску;
  - должен отвергнуть лишнее поле верхнего уровня целиком;
  - должен создать строку `pending` до ответа и перевести её в `timeout`;
  - должен на повтор того же ключа и хеша вернуть первый отчёт и не подменить заявления;
  - должен не менять `runs.prompt_tokens` заявленными токенами;
  - должен не класть `report` в следующее сообщение модели;
  - должен скрыть секрет в выдержке через `redact`;
  - должен отвергнуть URL внутри `report`;
  - должен не импортировать клиент сервиса из `src/queue`;
  - должен при нуле строк обновления не ставить `succeeded` и не вызывать `finish`.
- DoD: `npx vitest run test/services/service-call.test.ts` зелёный. `npm test` зелёный. В `GET /v1/runs/:id` отчёта нет. Колонки `run_steps.duration_ms` нет. Очередь не импортирует `src/services`. Секрета в фикстуре, похожего на настоящий ключ, нет: строка вида `test-secret-value`.
- Не делать: экраны админки, журнал токенов самого хаба, latency и `finish_reason` в `run_steps`, вынос `FILE_ROOT`, репозиторий `harness-files`, вторую живую версию на проводе, локальный запасной исполнитель, крон, пакет npm, правку `STEP_KINDS`, возврат инструментов чату `coder-cloud`, снятие `reasoning_effort`.
- Задание: шаблон раздела 2.3 и `.cursor/skills/harness-build/prompts.md`. Отличия: пакет M5-P1, ветка `m1/m5-p1-service-report`, пути и запреты этого раздела, миграция `012` разрешена, `src/contracts/**` и прочие миграции нет, спека `docs/spec/09-tool-v2.md` обязательна к прочтению, M4 и `harness-files` не делать, статусы плана не менять.

## 18. Что в M1 считается готовностью всего среза

Оркестратор закрывает M1, когда одновременно:

- пакеты P0–P10 в статусе `done`;
- семь сценариев P9 зелёные на `harness_test`;
- `npm test` зелёный;
- человек по README поднял воркер и API и создал один запуск, который фейковая или живая модель довела до конечного статуса;
- в репозитории нет секретов и нет запрещённых зависимостей.

Живой `qwen` может ошибиться в выборе файла. Это не отменяет M1, если семь фейковых сценариев зелёные и сбой записан в отчёте P9. Платформа в этом срезе доказывает очередь, журнал и отказ от опасного хода. Качество модели на свободном тексте доказывает бенч стека от 17 октября 2026 и отдельный живой прогон, не счётчик M1.

## 19. Порядок работы оркестратора на первую сессию

1. Убедиться, что файл лежит в репозитории как `docs/PLAN.md`.
2. Поставить M1-P0 в `in_progress` и выдать его одному агенту.
3. После отчёта прогнать ревью по I15, I17, I20 и DoD P0. Затем `done`.
4. Перевести P1, P2, P3 в `ready`. P4 оставить `pending`, пока P3 не влит: ему нужен `redact`.
5. Выдать P1, P2, P3 тремя worktree. По мере `done` у P3 выдать P4.
6. Дальше по разделу 15. Не открывать M2 из интереса исполнителя.
