-- Старая проверка пускала report_status = valid при report is null.
-- Перед новой проверкой такие строки становятся absent, а claimed-поля — null:
-- вторая проверка таблицы не принимает absent с заполненными заявлениями.
-- Имя старой проверки читается из pg_constraint по тексту, не по номеру checkN.

update service_results
set
  report_status = 'absent',
  claimed_prompt_tokens = null,
  claimed_completion_tokens = null,
  claimed_cost_usd = null,
  claimed_finish_reason = null
where report_status = 'valid'
  and report is null;

do $$
declare
  found_count integer;
  found_name text;
begin
  select count(*)::integer, min(conname)
    into found_count, found_name
  from pg_constraint
  where conrelid = 'service_results'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%report_status = ''valid''::text%'
    and pg_get_constraintdef(oid) like '%report IS NULL%'
    and pg_get_constraintdef(oid) not like '%IS NOT NULL%'
    and pg_get_constraintdef(oid) not like '%claimed_%';

  if found_count <> 1 then
    raise exception 'expected one check that allows valid without report, found %', found_count;
  end if;

  execute format('alter table service_results drop constraint %I', found_name);
end
$$;

alter table service_results
  add constraint service_results_report_not_null check (
    (report_status = 'valid' and report is not null)
    or (report_status in ('absent', 'invalid') and report is null)
  );
