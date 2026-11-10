-- Локальный агент M1. Повтор сида не создаёт вторую строку с тем же slug.
insert into agents (
  id,
  tenant_id,
  slug,
  display_name,
  system_prompt,
  model_alias,
  provider,
  max_steps,
  tool_allowlist,
  max_completion_tokens
) values (
  '00000000-0000-4000-8000-000000000001',
  'local',
  'clerk',
  'Клерк',
  $prompt$Отвечай по результатам инструментов. Не выдумывай содержимое файлов. Инструменты только из списка: read_file и list_dir. Окончательный ответ пиши обычным текстом, без предисловия, без обратных кавычек и без блоков кода.$prompt$,
  'agent',
  'local',
  8,
  array['read_file', 'list_dir']::text[],
  4096
)
on conflict (tenant_id, slug) do nothing;
