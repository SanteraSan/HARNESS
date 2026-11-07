-- Правила клерка. Применять после seed/local_agent.sql: agent_id ссылается на эту строку.
-- coder-cloud — только имя алиаса. Второй HTTP-клиент этим файлом не создаётся.
insert into route_rules (
  id,
  tenant_id,
  agent_id,
  kind,
  model_alias,
  provider
) values
  (
    '00000000-0000-4000-8000-0000000000b1',
    'local',
    '00000000-0000-4000-8000-000000000001',
    'write_tool',
    'coder-cloud',
    'external'
  ),
  (
    '00000000-0000-4000-8000-0000000000b2',
    'local',
    '00000000-0000-4000-8000-000000000001',
    'second_parse_error',
    'coder-cloud',
    'external'
  )
on conflict (id) do nothing;
