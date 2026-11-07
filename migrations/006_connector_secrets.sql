-- M3-P3. 001 не меняется.
-- Шифртекст живёт здесь, ключ — только в процессе. Открытое значение в строку не пишется.
-- Связь: секрет доступен одному агенту или одному отделу, не обоим сразу.
-- Повтор той же пары не создаёт вторую строку: частичный уникальный индекс.
-- grants каскадом уходят вместе с секретом и с агентом, иначе очистка harness_test
-- упрётся в FK на delete from agents.

create table connector_secrets (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  name text not null,
  ciphertext bytea not null,
  nonce bytea not null,
  salt bytea not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, name),
  constraint connector_secrets_tenant_length check (char_length(tenant_id) between 1 and 64),
  constraint connector_secrets_name_length check (char_length(name) between 1 and 200),
  constraint connector_secrets_nonce_length check (octet_length(nonce) = 12),
  constraint connector_secrets_salt_length check (octet_length(salt) = 16),
  -- Тело AES-GCM, 1..4096 байт, и 16 байт тега.
  constraint connector_secrets_ciphertext_length check (
    octet_length(ciphertext) between 17 and 4112
  )
);

create table connector_secret_grants (
  id uuid primary key default gen_random_uuid(),
  secret_id uuid not null references connector_secrets (id) on delete cascade,
  agent_id uuid references agents (id) on delete cascade,
  department text,
  created_at timestamptz not null default now(),
  constraint connector_secret_grants_one_subject check (
    (
      agent_id is not null
      and department is null
    )
    or (
      agent_id is null
      and department is not null
      and char_length(department) between 1 and 200
    )
  )
);

create unique index connector_secret_grants_agent_uq
  on connector_secret_grants (secret_id, agent_id)
  where agent_id is not null;

create unique index connector_secret_grants_department_uq
  on connector_secret_grants (secret_id, department)
  where department is not null;
