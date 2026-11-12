# 09. Конверт harness.tool.v2

## Назначение

Живой вызов хаба к сервису — этот документ. Отчёт сервиса приезжает в теле ответа того же `POST /v1/tools/{name}`, который отправил хаб. Входящего маршрута, callback и webhook нет.

Идентификатор один: `harness.tool.v2`. У объекта `report` своей версии нет. Ключ `version` или `contract` внутри `report` — лишнее поле этого объекта.

`harness.tool.v1` закрыт. Его разбирают `contract/` и `src/runner/tool-result-text.ts`. Этот пакет поля v1 не добавляет и v1 на провод не ставит. Двух живых версий на проводе нет. Первый сервис, который начнут писать после реализации хаба, пишется на v2.

Манифест остаётся `harness.services.v1`. Функция разбора — `parseServicesManifest` в `contract/manifest.ts`. Поле `version` инструмента остаётся строка `1` (`TOOL_VERSION`). Эти два имени не поднимать: провод v2 их не заменяет.

## Что в пункт не входит

Нет входящего приёма отчёта. Нет экрана админки и нет отчёта в `GET /v1/runs/:id`. Нет колонки `run_steps.duration_ms` и нет миграции `011_step_duration.sql`. Нет нового значения в `STEP_KINDS`. Нет `parent_run_id` у вызова сервиса. Нет `chat_id` в таблицах этого документа. Нет таблицы `tool_idempotency` в базе хаба: она живёт у сервиса, как в `02-contract.md`. Нет маршрутов блобов и нет сверки id из `blobs` с таблицей `blobs`: файла `010_blobs.sql` ещё нет. Нет клиента в `src/queue/**`. Нет локального запасного исполнителя, если сервис не ответил. Нет крона. Нет кода репозитория `harness-files`: его начинают после того, как хаб уже вызывает v2.

## Правила ядра

Сохраняются **I1**, **I4**, **I7**, **I13**, **I15**, **I17**, **I20**. Очередь не импортирует клиент сервиса. `redact` стоит до журнала и до следующего сообщения модели. Ноль строк у обновления поручения не ставит запуску `succeeded` и не вызывает `finish`. Один процесс воркера — один запуск, один fetch за раз. Зависимости хаба не пополняются. Миграции `001`…`008` не переписываются. Секрет сравнивается и маскируется по **I20**.

**I12** для локальных инструментов M1 не открывает сеть. HTTP делает клиент в `src/services/**`, его вызывает раннер после коммита захвата.

## Пределы

Числа ниже не выбираются заново.

| Имя | Значение | Факт |
| --- | --- | --- |
| тело `POST /v1/runs` | 32 КиБ | `JSON_BODY_LIMIT_BYTES` в `src/api/body.ts`. Не поднимать |
| тело запроса сервису | 32 КиБ | тот же предел, до сокета |
| тело ответа сервиса | 393627 байт | `SERVICE_RESPONSE_BODY_BYTES` в `src/runner/tool-result-text.ts`. До `JSON.parse` |
| `report` после `redact` | 8192 байт | внутри уже принятого тела. Потолок 393627 из-за отчёта не растёт |
| `duration_ms` | целое 0..600000 | поле конверта |
| `text` | до 65536 кодпоинтов | как v1 |
| `error` | 1..200 кодпоинтов | без управляющих символов |
| `blobs` | до 8 uuid, без повторов | при `ok: false` массив пуст |
| выдержка | 2000 кодпоинтов | после `redact` |
| шаги следа | не больше 16 | `step_index` 0..15 |
| `tool_calls` шага | не больше 8 | |
| чтение | 30 с | `AbortSignal.timeout` |
| запись | 60 с | `AbortSignal.timeout` |
| сырой `report` | 30 суток | затем `null`, пачка не больше 20 строк |

Фраза «64 КиБ плюс конверт 4 КиБ» не действует. В коде разбора записано 393627.

Глубина обхода JSON — 32, как `SCAN_DEPTH_MAX` у разбора v1. Глубже — отказ всего тела.

## Запрос

`POST /v1/tools/{name}`. `{name}` — один сегмент, алфавит `TOOL_NAME_RE` из `contract/limits.ts`. Слэш, `.` и `..` на провод не уходят. Адрес собирается из `base_url` записи `parseServicesManifest` и этого пути. Другой адрес, в том числе из ответа, не используется. `redirect: "error"`.

Заголовки:

- `Authorization: Bearer <секрет этого сервиса>`, если в манифесте `auth.type` равен `bearer`. Пустой секрет на провод не отправляется.
- `Content-Type: application/json; charset=utf-8`.
- `X-Contract-Version: harness.tool.v2`. Значение совпадает с полем `contract`. Иначе сервис отвечает `400` и `reason: "unsupported_version"`.
- Для `effect: "write"` ровно один `Idempotency-Key`. Для `effect: "read"` заголовок не шлётся. Сервис на чтении строку идемпотентности не создаёт.

`Idempotency-Key` — одна quoted-string. Внутри кавычек ровно `<run_id>:<tool_call_id>`. Правила ключа те же, что в `01-services.md`.

Тело, других полей нет. `nonce` обязателен. Его пишет хаб: `crypto.randomUUID()`, нижний регистр. На повтор транспорта того же поручения nonce новый не выпускается: уходят те же байты.

```json
{
  "contract": "harness.tool.v2",
  "run_id": "00000000-0000-4000-8000-000000000010",
  "tool_call_id": "call_1",
  "agent_id": "00000000-0000-4000-8000-000000000001",
  "service": "files",
  "name": "read_file",
  "arguments": { "path": "notes/a.txt" },
  "nonce": "00000000-0000-4000-8000-0000000000aa"
}
```

`run_id`, `agent_id`, `nonce` — uuid нижнего регистра, как `UUID_RE` в `contract/limits.ts`. `tool_call_id` — `TOOL_CALL_ID_RE`. `service` — `SERVICE_ID_RE` и совпадает с `id` записи манифеста, с которой ушёл вызов. `chat_id` в теле нет. `idempotency_key` в тело не кладётся: хаб снимает его с копии аргументов до проверки и до хеша, как в `01-services.md`.

Неизвестное поле — отказ всего запроса на стороне сервиса: `400`, `reason: "unknown_field"`. Ключи `__proto__`, `constructor`, `prototype` — тот же отказ. Тело больше 32 КиБ хаб не отправляет.

Канонический хеш — SHA-256 байтов, которые реально ушли. Канон тот же, что в разделе «Канонический хеш записи» `01-services.md`: UTF-8, без пробелов между лексемами, ключи по байтам UTF-8. В хеш входят `contract`, `nonce` и остальные поля тела. Заголовки в хеш не входят.

## Ответ

Верхний объект закрыт. Лишнего поля нет. Неизвестное поле верхнего уровня — отказ всего ответа: текст в модель не идёт, строка `service_results` не пишется.

Обязательны всегда: `contract` (`harness.tool.v2`), `ok`, `truncated`, `duration_ms`, `blobs`, `nonce`, `run_id`, `tool_call_id`. При `ok: true` обязателен `text`, запрещены `error` и `error_code`. При `ok: false` обязательны `error` и `error_code`, запрещён `text`, `blobs` пуст. `report` — необязательный объект. Это единственное необязательное поле верхнего уровня.

`nonce`, `run_id` и `tool_call_id` ответа сравниваются с строкой поручения побайтно. Не совпал хотя бы один — тело ни к какому запуску не привязывается: ни к текущему, ни к идентификаторам из тела. Строка результата не пишется. В модель идёт короткая ошибка хаба, не текст этого тела.

`error_code` — закрытый набор v1: `invalid_args`, `not_found`, `forbidden`, `too_large`, `conflict`, `unavailable`, `internal`. Неизвестная строка при разборе становится `internal`. Нестрока — отказ всего ответа. `duration_ms` — целое 0..600000. Это заявление сервиса. Ожидание хаба его не увеличивает.

`service`, `service_id`, `prompt_tokens`, `completion_tokens`, `cost_usd` на верхнем уровне — неизвестное поле, отказ всего ответа. Заявления живут только внутри `report`.

Ошибка HTTP, других полей нет: `{ "reason": "<код>" }`. Коды те же, что таблица в `01-services.md`. Такое тело конвертом v2 не считается.

### Класс без модели

Сервис без своей модели — нормальный ответ: поручение, текст или ошибка, `duration_ms`. След не обязателен.

```json
{
  "contract": "harness.tool.v2",
  "ok": true,
  "text": "готово",
  "truncated": false,
  "duration_ms": 4,
  "blobs": [],
  "nonce": "00000000-0000-4000-8000-0000000000aa",
  "run_id": "00000000-0000-4000-8000-000000000010",
  "tool_call_id": "call_1",
  "report": { "has_model": false }
}
```

Ключ `report` необязателен. Опущенный ключ — отсутствие блока, не ошибка конверта. Сервис не обязан слать `null`.

### Класс со следом

`has_model: true` и пустой след законны: шагов нет, строка в `service_model_steps` не пишется. `has_model: false` и непустой `steps` — отчёт `invalid`. Пустой след здесь — ключ `steps` опущен, JSON `null` или массив длины 0. Массив длины 1 и больше при `has_model: false` — непустой след.

```json
{
  "contract": "harness.tool.v2",
  "ok": true,
  "text": "итог",
  "truncated": false,
  "duration_ms": 20,
  "blobs": [],
  "nonce": "00000000-0000-4000-8000-0000000000aa",
  "run_id": "00000000-0000-4000-8000-000000000010",
  "tool_call_id": "call_1",
  "report": {
    "has_model": true,
    "claimed_prompt_tokens": 12,
    "claimed_completion_tokens": 3,
    "claimed_cost_usd": "0",
    "finish_reason": "stop",
    "steps": [
      {
        "step_index": 0,
        "excerpt": "короткий ход",
        "finish_reason": "stop",
        "claimed_prompt_tokens": 12,
        "claimed_completion_tokens": 3,
        "claimed_cost_usd": "0",
        "tool_calls": [{ "id": "inner_1", "name": "lookup" }]
      }
    ]
  }
}
```

## Объект report

Закрытый объект без версии. Лишнее поле — отчёт `invalid`. Годный `text` или строка `error` при этом всё равно идёт в модель. Идемпотентность из-за битого отчёта не останавливается: поручение становится `completed`.

Поля:

- `has_model` — boolean, обязателен. `null` и строка не проходят.
- `claimed_prompt_tokens` — целое JSON 0..2147483647, JSON `null` или отсутствие ключа.
- `claimed_completion_tokens` — то же.
- `claimed_cost_usd` — строка, JSON `null` или отсутствие ключа. Строка совпадает с константой хаба `^(0|[1-9][0-9]{0,7})(\.[0-9]{1,6})?$`. Этот шаблон из отчёта не берётся. Число JSON, экспонента и минус — битый тип.
- `finish_reason` — `stop`, `length`, `tool_calls`, `content_filter`, `error`, JSON `null` или отсутствие ключа.
- `steps` — массив, `null` или ключ опущен.

Других полей нет. `prompt`, `messages`, `system`, `callback`, `blobs_url`, `url`, `webhook`, `href` — лишнее поле.

Элемент `steps` — закрытый объект:

- `step_index` — целое, равно позиции в массиве, начиная с 0. Дырка, повтор и длина больше 16 — отчёт `invalid`, ни одна строка следа не пишется.
- `excerpt` — строка 0..2000 кодпоинтов. Длиннее — отчёт `invalid`, хвост не обрезается и в базу не кладётся. Полный промпт в след не принимается.
- `finish_reason`, `claimed_prompt_tokens`, `claimed_completion_tokens`, `claimed_cost_usd` — те же правила, ключ необязателен.
- `tool_calls` — массив до 8, `null` или ключ опущен. Элемент закрыт: `id` (`TOOL_CALL_ID_RE`) и `name` (`TOOL_NAME_RE`). Аргументов и текста промпта в элементе нет.

Суммы шагов в колонки `service_results` не складываются и в `runs` не пишутся. Колонки результата берутся только из полей самого `report`. Колонки шага — только из элемента. Оба места — заявления.

Запрещённый символ в любой строке отчёта — отчёт `invalid`. Набор тот же, что снимается из текста инструмента в `02-contract.md`: C0 кроме перевода строки и таба, плюс U+202A–U+202E, U+2066–U+2069, U+200B–U+200F и U+FEFF. Из отчёта символы не вычищаются: блок отвергается.

Адрес внутри `report` — отчёт `invalid`. Проверка хаба фиксированная, не `RegExp` из входных данных: в строке отчёта, уже ограниченной схемой, в нижнем регистре есть `http://` или `https://`. Ключи `callback`, `blobs_url`, `url`, `webhook`, `href` — лишние поля. Адрес в поле `text` конверта этим правилом не отвергается.

Битый тип, лишнее поле, непустой след при `has_model: false`, адрес, промпт длиннее выдержки — одно следствие: `report_status = invalid`, jsonb не хранится, колонки заявлений отчёта `NULL`, строки `service_model_steps` нет. `text` или `error` конверта в модель идёт. `claimed_duration_ms` берётся из годного поля конверта `duration_ms`, не из отчёта.

Годный отчёт хранится jsonb после `redact` строк. Потолок — 8192 байта UTF-8 канонического JSON без пробелов между лексемами. Сначала `redact`, потом замер. Выше потолка — тот же `invalid`, jsonb в INSERT не передаётся. Ограничение SQL повторяет 8192 и вторым порогом не служит.

## Null

NULL в колонки пишет хаб. Сервис не обязан присылать явный `null`.

Три состояния не склеиваются:

1. Вызов не вернулся (`pending`, `timeout`, `transport_error`, `abandoned`). Строки `service_results` нет.
2. Конверт разобран, ключ `report` опущен. `report_status = absent`, jsonb `NULL`, колонки `claimed_prompt_tokens`, `claimed_completion_tokens`, `claimed_cost_usd`, `claimed_finish_reason` — `NULL`. `claimed_duration_ms` равен `duration_ms` конверта.
3. Конверт разобран, отчёт прошёл схему, и в поле, где выше разрешён `null`, пришёл явный JSON `null`. Колонка тоже `NULL`. В проверенном jsonb ключ есть и значение `null`. Опущенный ключ в этом jsonb отсутствует.

Для отчёта за период состояния 2 и 3 оба значат «числа нет»: читаются колонки, не различие ключей. Различие лежит в jsonb, пока блок не снят уборкой. После уборки остаётся SQL `NULL`. Отдельной колонки «ключ отсутствовал» нет.

JSON `null` у самого ключа `report` схема не принимает: это не объект. Следствие — `report_status = invalid` по правилу битого типа, текст конверта в модель идёт, jsonb нет. Явный `null` хранится только у полей внутри объекта, который прошёл схему.

`steps: null` при прошедшем отчёте — пустой след. В jsonb пишется `null`. Строк шагов нет. Опущенный `steps` и `[]` тоже не дают строк. В jsonb у `[]` пустой массив, у опущенного ключа поля нет.

## Что доказал хаб и что заявил сервис

Хаб пишет сам, из манифеста и из своих часов. Имя сервиса из ответа не принимается.

На `service_invocations`, до fetch и дальше по наблюдению:

- `id` — `crypto.randomUUID()`;
- `tenant_id` — из строки `runs`, не из тела;
- `service_id` — `ServiceEntry.id` манифеста;
- `run_id`, `tool_call_id`;
- `request_sha256` — 32 байта канонического запроса;
- `nonce`;
- `worker_id`;
- `started_at` и `finished_at` — `now()` Postgres;
- `hub_duration_ms` — разность этих двух меток в SQL, не `Date.now()`;
- `http_status` или `transport_code`;
- `response_bytes`;
- `status`.

`claimed_duration_ms` и поля `claimed_*` — заявления сервиса. В `runs.prompt_tokens`, `runs.completion_tokens`, `run_steps.cost_usd` и в `resolveModel` они не пишутся. `hub_duration_ms` к заявлению не прибавляется. Внутренние `tool_calls` сервиса остаются в `service_model_steps` и маршрутизацию хаба не меняют.

`run_steps` этот вызов по-прежнему пишет как `tool_result` или `policy_deny` существующими видами. Колонку длительности туда не добавлять. Токены шага, latency, `finish_reason` и отдельную колонку id вызова этот документ в журнал хаба не добавляет. В выдержку шага попадает подготовленный текст инструмента, не объект `report`.

## Идемпотентность

Ключ — `<run_id>:<tool_call_id>`. Отпечаток — SHA-256 канонического тела, включая первый отчёт, потому что отчёт — часть того же ответа.

Повтор того же ключа и того же хеша возвращает первое тело. Заявления из второго тела не дописываются. Другое тело — `409` и `reason: "idempotency_conflict"`, без нового эффекта. `422` нет.

У `effect: "write"` не больше двух отправок одного и того же тела. Вторая отправка — только при обрыве, таймауте или `409` `idempotency_in_progress`. Обрыв и таймаут повторяются сразу. `idempotency_in_progress` повторяется один раз после паузы 1 с. Пауза транзакцию базы не держит. У `effect: "read"` второй отправки нет. `401` не повторяется. Годный конверт, битый `report`, чужой nonce, лишнее поле и `idempotency_conflict` не повторяются.

На хабе уникальна пара `(run_id, tool_call_id)`. Повтор транспорта обновляет ту же строку `pending` и шлёт сохранённые байты. Вторая строка и второй nonce не создаются. Повтор всего запуска после reaper — новый ход модели и новый `tool_call_id`. Старый id хаб не подставляет.

## Данные

Файл миграции назначает пакет в `PLAN.md`: `migrations/012_service_reports.sql`. Этот документ файл не создаёт. `001`…`008` не меняются. `009_model_slots.sql` и `010_blobs.sql` уже названы другими документами, файлов нет, этот документ их номера не занимает. `011_step_duration.sql` не создаётся.

`tenant_id` в схеме уже есть (`runs.tenant_id`). Индекс списка по сервису включает его: отчёт за период фильтрует арендатора. `chat_id` в таблицы не входит.

```sql
create table service_invocations (
  id uuid primary key,
  tenant_id text not null,
  service_id text not null,
  run_id uuid not null references runs (id),
  tool_call_id text not null,
  request_sha256 bytea not null,
  nonce uuid not null,
  worker_id text not null,
  status text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  hub_duration_ms integer,
  http_status integer,
  transport_code text,
  response_bytes integer,
  unique (run_id, tool_call_id),
  check (octet_length(request_sha256) = 32),
  check (hub_duration_ms is null or hub_duration_ms >= 0),
  check (response_bytes is null or response_bytes >= 0),
  check (status in ('pending', 'completed', 'timeout', 'transport_error', 'abandoned')),
  check (transport_code is null or transport_code in (
    'timeout', 'connection_error', 'payload_too_large', 'unknown_field',
    'invalid_envelope', 'echo_mismatch', 'unauthorized',
    'idempotency_conflict', 'http_error'
  )),
  check (
    (status = 'pending' and finished_at is null and transport_code is null)
    or (status = 'completed' and finished_at is not null and transport_code is null)
    or (status = 'timeout' and finished_at is not null and transport_code = 'timeout')
    or (status = 'abandoned' and finished_at is not null and transport_code is null)
    or (status = 'transport_error' and finished_at is not null and transport_code in (
      'connection_error', 'payload_too_large', 'unknown_field', 'invalid_envelope',
      'echo_mismatch', 'unauthorized', 'idempotency_conflict', 'http_error'
    ))
  )
);

create index service_invocations_tenant_service_started_idx
  on service_invocations (tenant_id, service_id, started_at);

create index service_invocations_run_idx
  on service_invocations (run_id);

create index service_invocations_pending_idx
  on service_invocations (started_at)
  where status = 'pending';

create table service_results (
  invocation_id uuid primary key references service_invocations (id),
  ok boolean not null,
  error_code text,
  excerpt text not null,
  truncated boolean not null,
  report_status text not null,
  report jsonb,
  claimed_duration_ms integer not null,
  claimed_prompt_tokens integer,
  claimed_completion_tokens integer,
  claimed_cost_usd numeric,
  claimed_finish_reason text,
  check (report_status in ('absent', 'valid', 'invalid')),
  check (char_length(excerpt) <= 2000),
  check (claimed_duration_ms between 0 and 600000),
  check (claimed_prompt_tokens is null or claimed_prompt_tokens >= 0),
  check (claimed_completion_tokens is null or claimed_completion_tokens >= 0),
  check (claimed_cost_usd is null or claimed_cost_usd >= 0),
  check (claimed_finish_reason is null or claimed_finish_reason in (
    'stop', 'length', 'tool_calls', 'content_filter', 'error'
  )),
  check (error_code is null or error_code in (
    'invalid_args', 'not_found', 'forbidden', 'too_large',
    'conflict', 'unavailable', 'internal'
  )),
  check ((ok and error_code is null) or (not ok and error_code is not null)),
  check (
    (report_status = 'valid' and report is not null)
    or (report_status in ('absent', 'invalid') and report is null)
  ),
  check (report is null or octet_length(report::text) <= 8192),
  check (report_status = 'valid' or (
    claimed_prompt_tokens is null
    and claimed_completion_tokens is null
    and claimed_cost_usd is null
    and claimed_finish_reason is null
  ))
);

create table service_model_steps (
  invocation_id uuid not null references service_invocations (id),
  step_index integer not null,
  excerpt text not null,
  finish_reason text,
  claimed_prompt_tokens integer,
  claimed_completion_tokens integer,
  claimed_cost_usd numeric,
  tool_calls jsonb,
  primary key (invocation_id, step_index),
  check (step_index between 0 and 15),
  check (char_length(excerpt) <= 2000),
  check (finish_reason is null or finish_reason in (
    'stop', 'length', 'tool_calls', 'content_filter', 'error'
  )),
  check (claimed_prompt_tokens is null or claimed_prompt_tokens >= 0),
  check (claimed_completion_tokens is null or claimed_completion_tokens >= 0),
  check (claimed_cost_usd is null or claimed_cost_usd >= 0),
  check (tool_calls is null or jsonb_typeof(tool_calls) = 'array')
);
```

Jsonb не индексируется. Строка `service_results` есть только у `completed`. Шаги пишутся только вместе с `report_status = valid`. Сырое тело ответа колонкой не хранится.

Уборка jsonb вызывает существующий проход воркера: `runIteration` в `src/worker.ts`, сразу после `reapExpired` и до `claimNext`. Функции лежат в `src/services/**`. Очередь их не импортирует. Крон не заводится.

1. `pending` → `abandoned`, когда у строки нет запуска `running` с `locked_by`, равным `worker_id` этой строки. `finished_at = now()`. Статус запуска этот оператор не меняет. `succeeded` не ставит.
2. У `service_results` обнуляется только `report`, если он не `null` и `finished_at` поручения старше `now() - interval '30 days'`. За один проход не больше 20 строк. Колонки `claimed_*`, `excerpt`, `ok`, `report_status`, `truncated` не чистятся. Строки шагов не чистятся.

Часы уборки — `now()` Postgres.

## Порядок

Захват запуска коммитится до сети. Соединение базы на время fetch не держится.

1. Пустая `SERVICES_MANIFEST`: fetch нет, локальные инструменты и правила M3-P7 остаются.
2. Переменная задана, файл или сумма не сошлись: процесс выходит до захвата. Правило суммы — `02-contract.md`.
3. Имя из манифеста исполняется только клиентом v2. После ошибки сети локальный `execute` этого имени не вызывается. Имя вне манифеста до HTTP не доходит: шаг `policy_deny`.
4. Чат без списка инструментов сервис не вызывает.
5. Аргументы длиннее 32 КиБ не парсятся и в сокет не уходят.
6. Короткая транзакция вставляет `service_invocations` со статусом `pending` и коммитится до fetch.
7. `fetch` с таймаутом эффекта. `redirect: "error"`. Секрет берётся в `src/config.ts` из окружения, которое модуль уже прочитал. Имя переменной — `auth.env` манифеста и обязано совпасть с `ENV_NAME_RE`. `src/services/**` сам `process.env` не читает.
8. Длина тела проверяется до `JSON.parse`. Длиннее 393627 — `transport_code = payload_too_large`, без разбора.
9. Ключи `__proto__`, `constructor`, `prototype` на любой глубине — отказ всего тела, `invalid_envelope`. Текст в модель не идёт.
10. Конверт сверяется закрытой схемой. Не сошёлся — `invalid_envelope` или `unknown_field`, строки результата нет.
11. Эхо `nonce`, `run_id`, `tool_call_id` сверяется со строкой. Не сошлось — `echo_mismatch`, тело выбрасывается.
12. `report` разбирается отдельно. Провал блока не отменяет годный `text` или `error`.
13. В роль `tool` попадает только подготовленный `text` или строка `error`: снятие скрытых символов, `redact` всего текста, обрезка до 8000 кодпоинтов. Объект `report`, сырой JSON и заголовки в сообщение не кладутся.
14. Обновление поручения — один короткий оператор: строка ещё `pending`, `worker_id` этот, запуск `running` и `locked_by` этот воркер. В той же транзакции пишется `service_results` и, при годном следе, шаги. Ноль строк: ответ опоздал, результат не пишется, шаг не пишется, `finish` из этого оператора не вызывается, `succeeded` не ставится.
15. Потеря heartbeat до этого оператора: обновление не выполняется, поручение не `completed`. Reaper запуска `succeeded` не ставит.
16. `finish` запуска по-прежнему только своим `locked_by` и `status = 'running'`, отдельным путём раннера, не из обновления поручения.

Таймаут переводит `pending` в `timeout` тем же условием лока. Обрыв — `transport_error` и `connection_error`. `401` — `unauthorized`. `409` `idempotency_conflict` — `idempotency_conflict`. Прочий HTTP без конверта — `http_error` и записанный `http_status`. Успешный конверт, включая `report_status = invalid`, — `completed`, `http_status = 200`, `transport_code` пустой.

Сервис недоступен — ошибка инструмента. Запуск жив. Цикл модели продолжается, пока лок есть и не кончился `max_steps`.

## Безопасность

Свой bearer у каждого сервиса. На стороне сервиса хранится SHA-256, сравнение — `timingSafeEqual` по 32 байтам. Хаб значение в журнал, в манифест и в репозиторий не пишет. На время процесса секрет входит в список `redact`.

Сервис не называет URL. `Location` не преследуется.

`redact` выполняется до выдержки, до jsonb и до следующего сообщения модели. В pino есть `run_id`, `service_id`, код статуса. Нет тела, аргументов, `Authorization`, отчёта и секрета.

Чужой `pattern` в `RegExp` не компилируется. Обход отчёта — фиксированные проверки этого файла.

Лимит `POST /v1/runs` остаётся 32 КиБ. Бюджет отчёта 8192 лежит внутри потолка ответа 393627.

## Тесты

Команда пакета названа в `PLAN.md`. База кончается на `_test`. Модуль `postgres` не мокается. HTTP сервиса — фейковый сервер внутри теста. Живой `harness-files` не нужен.

Обязательные сценарии: сервис без модели; сервис со следом; нет ключа `report` и NULL в колонках заявлений отчёта при записанном `claimed_duration_ms`; годный `text` и битый `report`; чужой `nonce`; лишнее поле верхнего уровня; `pending`, затем `timeout`; повтор того же ключа и хеша возвращает первый отчёт; `claimed_prompt_tokens` не меняет `runs.prompt_tokens`; объект `report` отсутствует в следующем сообщении модели; секрет в выдержке закрыт `redact`; URL внутри `report` даёт `invalid`.

## Критерии готовности

Хаб на провод шлёт только `harness.tool.v2`. Отчёт читается из того же ответа. `runs.prompt_tokens` и `runs.completion_tokens` считаются из `usage` шлюза. Колонки `run_steps.duration_ms` нет. Очередь клиент сервиса не импортирует.
