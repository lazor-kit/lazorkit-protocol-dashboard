begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

select ok(not has_function_privilege(r, f, 'execute'), format('%s cannot call %s', r, f))
from unnest(array['anon', 'authenticated', 'service_role']) as r,
     unnest(array['lk.lk_dashboard(text, text)', 'lk.lk_health()']) as f;

set local role anon;

select is(
  (select array_agg(item->>'programKey') from jsonb_array_elements(public.lk_health()->'programs') as h(item)),
  array['1', '3'], 'public health covers the two Protocol deployments'
);

with payload as (
  select cluster, span, program_key, public.lk_dashboard(cluster, span) as view
  from (values ('mainnet', '1'), ('devnet', '3')) as network(cluster, program_key)
  cross join unnest(array['24h', '7d', '30d', 'all']) as span
)
select ok(
  jsonb_array_length(view->'programs') = 1
    and view #>> '{programs,0,programKey}' = program_key
    and (select array_agg(key) from jsonb_object_keys(view->'kpis') as k(key)) = array[program_key]
    and (select array_agg(key) from jsonb_object_keys(view->'breakdowns') as k(key)) = array[program_key]
    and not exists (select 1 from jsonb_array_elements(view->'series') as s(point) where point->>'scope' <> program_key)
    and not exists (select 1 from jsonb_array_elements(view->'binaries') as b(item) where item->>'kind' <> 'v1-full')
    and not exists (select 1 from jsonb_array_elements(view->'latest') as l(item) where item->>'programKey' <> program_key)
    and view->'migration' = 'null'::jsonb,
  format('%s %s returns only Protocol metrics', cluster, span)
)
from payload;

reset role;
select * from finish();
rollback;
