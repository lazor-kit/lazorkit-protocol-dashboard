-- G1: the API roles can call the readers only; every writer and the lk schema itself are closed to them.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

set local role anon;
select lives_ok($$ select public.lk_schema_version() $$, 'G1 anon: lk_schema_version');
select lives_ok($$ select public.lk_dashboard('mainnet', '7d') $$, 'G1 anon: lk_dashboard');
select lives_ok($$ select public.lk_health() $$, 'G1 anon: lk_health');
select throws_ok($$ select public.lk_worker_context() $$, '42501', null, 'G1 anon: lk_worker_context denied');
select throws_ok($$ select public.lk_set_deployment(1, '{"status":"live"}') $$, '42501', null, 'G1 anon: lk_set_deployment denied');
select throws_ok($$ select public.lk_enqueue(1, 1, '[]', null) $$, '42501', null, 'G1 anon: lk_enqueue denied');
select throws_ok($$ select public.lk_pending(1, 1, 1, 'r') $$, '42501', null, 'G1 anon: lk_pending denied');
select throws_ok($$ select public.lk_ingest(1, 1, '[]', '{}', false) $$, '42501', null, 'G1 anon: lk_ingest denied');
select throws_ok($$ select public.lk_mark_attempt(1, 1, 's', 'r', 'e') $$, '42501', null, 'G1 anon: lk_mark_attempt denied');
select throws_ok($$ select public.lk_open_gaps(1, 1, 1) $$, '42501', null, 'G1 anon: lk_open_gaps denied');
select throws_ok($$ select public.lk_reparse_candidates(1, 1, 2, 1) $$, '42501', null, 'G1 anon: lk_reparse_candidates denied');
select throws_ok($$ select public.lk_write_state(1, 1, '{}', '{}', null) $$, '42501', null, 'G1 anon: lk_write_state denied');
select throws_ok($$ select public.lk_heartbeat('x', '{}') $$, '42501', null, 'G1 anon: lk_heartbeat denied');
select throws_ok($$ select public.lk_report_run(1, 1, '{}') $$, '42501', null, 'G1 anon: lk_report_run denied');
select throws_ok($$ select public.lk_compact(35) $$, '42501', null, 'G1 anon: lk_compact denied');
select throws_ok($$ select public.lk_verify(1, 1) $$, '42501', null, 'G1 anon: lk_verify denied');
select throws_ok($$ select public.lk_start_build(1, 2) $$, '42501', null, 'G1 anon: lk_start_build denied');
select throws_ok($$ select public.lk_promote_build(1, 2) $$, '42501', null, 'G1 anon: lk_promote_build denied');
select throws_ok($$ select count(*) from lk.events $$, '42501', 'permission denied for schema lk', 'G1 anon: lk schema closed');
select throws_ok($$ select lk.utc_day(now()) $$, '42501', 'permission denied for schema lk', 'G1 anon: lk helpers closed');
reset role;

set local role authenticated;
select lives_ok($$ select public.lk_dashboard('devnet', 'all') $$, 'G1 authenticated: lk_dashboard');
select throws_ok($$ select public.lk_ingest(1, 1, '[]', '{}', false) $$, '42501', null, 'G1 authenticated: lk_ingest denied');
select throws_ok($$ select count(*) from lk.daily $$, '42501', 'permission denied for schema lk', 'G1 authenticated: lk schema closed');
reset role;

set local role service_role;
select lives_ok($$ select public.lk_worker_context() $$, 'G1 service_role: lk_worker_context');
select lives_ok($$ select public.lk_heartbeat('test', '{}') $$, 'G1 service_role: lk_heartbeat');
select lives_ok($$ select public.lk_compact(35) $$, 'G1 service_role: lk_compact');
reset role;

-- every public.lk_* writer is closed to anon/authenticated (catches a writer added later without a revoke)
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'lk\_%'
      and p.proname not in ('lk_schema_version', 'lk_dashboard', 'lk_health')
      and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))),
  0, 'G1: no writer is executable by anon or authenticated');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'lk\_%' and not p.prosecdef),
  0, 'G1: every public.lk_* function is SECURITY DEFINER');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'lk\_%'
      and not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')),
  0, 'G1: every public.lk_* function pins its search_path');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'lk\_%' and 'int2'::regtype = any(p.proargtypes::regtype[])),
  0, 'B7: no lk_* RPC parameter is smallint');

select * from finish();
rollback;
