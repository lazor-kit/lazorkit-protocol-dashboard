begin;

-- Preserve the event log and existing grants on the two public reader names.
alter function public.lk_dashboard(text, text) set schema lk;
alter function public.lk_health() set schema lk;
revoke execute on function lk.lk_dashboard(text, text), lk.lk_health() from public, anon, authenticated, service_role;

create function lk.protocol_heartbeats(p_heartbeats jsonb) returns jsonb
language sql immutable as $$
  select p_heartbeats #- '{worker,detail,programs}' #- '{worker,detail,program}'
$$;

create function public.lk_dashboard(p_cluster text, p_window text) returns jsonb
language sql stable security definer set search_path = lk, pg_temp set statement_timeout = '10s' as $$
  with scope as (
    select case p_cluster when 'mainnet' then '1' when 'devnet' then '3' end as key,
           lk.lk_dashboard(p_cluster, p_window) as raw
  ), first_activity as (
    select lk.day_start(min(d.day)) as start_at
    from lk.daily d
    join lk.programs p on p.program_key = d.program_key and p.active_gen = d.gen
    where p.cluster = p_cluster and p.version = 1 and p_window = 'all'
  )
  select raw || jsonb_build_object(
    'range', case when p_window = 'all' then
               jsonb_set(raw->'range', '{start}', coalesce(to_jsonb(start_at), 'null'::jsonb))
             else raw->'range' end,
    'programs', (select coalesce(jsonb_agg(row), '[]'::jsonb)
                 from jsonb_array_elements(raw->'programs') as program(row)
                 where row->>'programKey' = key and row->>'version' = '1'),
    'kpis', case when (raw->'kpis') ? key then jsonb_build_object(key, raw->'kpis'->key) else '{}'::jsonb end,
    'series', (select coalesce(jsonb_agg(row order by ordinal), '[]'::jsonb)
               from jsonb_array_elements(raw->'series') with ordinality as point(row, ordinal)
               where row->>'scope' = key
                 and (p_window <> 'all' or (row->>'bucket')::date >= (start_at at time zone 'UTC')::date)),
    'breakdowns', case when (raw->'breakdowns') ? key then jsonb_build_object(key, raw->'breakdowns'->key) else '{}'::jsonb end,
    'binaries', (select coalesce(jsonb_agg(row order by ordinal), '[]'::jsonb)
                 from jsonb_array_elements(raw->'binaries') with ordinality as build(row, ordinal)
                 where row->>'kind' = 'v1-full'),
    'latest', (select coalesce(jsonb_agg(row order by ordinal), '[]'::jsonb)
                from jsonb_array_elements(raw->'latest') with ordinality as activity(row, ordinal)
                where row->>'programKey' = key and row->>'version' = '1'),
    'migration', null,
    'heartbeats', lk.protocol_heartbeats(raw->'heartbeats')
  )
  from scope cross join first_activity
$$;

create function public.lk_health() returns jsonb
language sql stable security definer set search_path = lk, pg_temp set statement_timeout = '10s' as $$
  select raw || jsonb_build_object(
    'programs', (select coalesce(jsonb_agg(row order by ordinal), '[]'::jsonb)
                 from jsonb_array_elements(raw->'programs') with ordinality as program(row, ordinal)
                 where row->>'version' = '1' and row->>'programKey' in ('1', '3')),
    'heartbeats', lk.protocol_heartbeats(raw->'heartbeats')
  )
  from (select lk.lk_health() as raw) as indexed
$$;

revoke execute on function public.lk_dashboard(text, text), public.lk_health(), lk.protocol_heartbeats(jsonb) from public;
grant execute on function public.lk_dashboard(text, text), public.lk_health() to anon, authenticated, service_role;

commit;

notify pgrst, 'reload schema';
