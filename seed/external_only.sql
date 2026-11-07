-- M3-E. Набор «только внешние». npm run seed этот файл не применяет:
-- иначе тесты M1, которые ждут локальный алиас клерка, станут красными.
-- resolveModel без сработавшего правила возвращает поля строки агента,
-- поэтому набор уводит клерка с алиаса agent / local.
-- В route_rules остаётся только внешний алиас. Код локального раннера не удаляется.
-- Применять после seed/local_agent.sql: agent_id ссылается на эту строку.

delete from route_rules
where tenant_id = 'local'
  and agent_id = '00000000-0000-4000-8000-000000000001';

update agents
set
  model_alias = 'coder-cloud',
  provider = 'external'
where id = '00000000-0000-4000-8000-000000000001'
  and tenant_id = 'local'
  and slug = 'clerk';

insert into route_rules (
  id,
  tenant_id,
  agent_id,
  kind,
  model_alias,
  provider
) values
  (
    '00000000-0000-4000-8000-0000000000e1',
    'local',
    '00000000-0000-4000-8000-000000000001',
    'write_tool',
    'coder-cloud',
    'external'
  ),
  (
    '00000000-0000-4000-8000-0000000000e2',
    'local',
    '00000000-0000-4000-8000-000000000001',
    'second_parse_error',
    'coder-cloud',
    'external'
  )
on conflict (id) do update set
  tenant_id = excluded.tenant_id,
  agent_id = excluded.agent_id,
  kind = excluded.kind,
  model_alias = excluded.model_alias,
  provider = excluded.provider;
