-- Потолок отчёта — 8192 байта канонического JSON, как decideReport.
-- report::text добавляет пробелы после : и , и отбраковывает годный отчёт у границы.

create or replace function harness_canonical_json(value jsonb)
returns text
language plpgsql
immutable
as $function$
declare
  kind text;
  item jsonb;
  object_key text;
  piece text;
  built text := '';
  first_piece boolean := true;
begin
  if value is null then
    return null;
  end if;
  kind := jsonb_typeof(value);
  if kind = 'null' then
    return 'null';
  elsif kind = 'boolean' or kind = 'number' then
    return value::text;
  elsif kind = 'string' then
    return to_json(value #>> '{}')::text;
  elsif kind = 'array' then
    for item in
      select element from jsonb_array_elements(value) as element
    loop
      piece := harness_canonical_json(item);
      if first_piece then
        built := piece;
        first_piece := false;
      else
        built := built || ',' || piece;
      end if;
    end loop;
    return '[' || built || ']';
  elsif kind = 'object' then
    for object_key in
      select key_name from jsonb_object_keys(value) as key_name
    loop
      piece := to_json(object_key)::text || ':' || harness_canonical_json(value -> object_key);
      if first_piece then
        built := piece;
        first_piece := false;
      else
        built := built || ',' || piece;
      end if;
    end loop;
    return '{' || built || '}';
  end if;
  return null;
end;
$function$;

create or replace function harness_canonical_json_bytes(value jsonb)
returns integer
language sql
immutable
as $function$
  select octet_length(convert_to(harness_canonical_json(value), 'UTF8'));
$function$;

do $drop$
declare
  constraint_name text;
begin
  for constraint_name in
    select con.conname
    from pg_constraint as con
    join pg_class as rel on rel.oid = con.conrelid
    where rel.relname = 'service_results'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%octet_length%report%text%'
  loop
    execute format('alter table service_results drop constraint %I', constraint_name);
  end loop;
end
$drop$;

alter table service_results
  add constraint service_results_report_canonical_bytes
  check (
    report is null
    or coalesce(harness_canonical_json_bytes(report), 8193) <= 8192
  );
