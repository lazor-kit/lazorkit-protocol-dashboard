-- G1: the API roles can call the readers only; every writer and the lk schema itself are closed to them.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- Readers run as anon / authenticated. Writers are checked with has_function_privilege rather than by calling them:
-- on the local Supabase image (postgres 17.6.1.106) a "permission denied for function" raised in a psql session
-- running as anon crashes the backend (signal 11; any revoked function, not only lk_*), while the same call through
-- PostgREST returns 42501 cleanly. The HTTP denial with the real anon key is covered by it/lk.it.test.ts.
set local role anon;
select lives_ok($$ select public.lk_schema_version() $$, 'G1 anon: lk_schema_version');
select lives_ok($$ select public.lk_dashboard('mainnet', '7d') $$, 'G1 anon: lk_dashboard');
select lives_ok($$ select public.lk_health() $$, 'G1 anon: lk_health');
select throws_ok($$ select count(*) from lk.events $$, '42501', 'permission denied for schema lk', 'G1 anon: lk schema closed');
select throws_ok($$ select lk.utc_day(now()) $$, '42501', 'permission denied for schema lk', 'G1 anon: lk helpers closed');
reset role;

set local role authenticated;
select lives_ok($$ select public.lk_dashboard('devnet', 'all') $$, 'G1 authenticated: lk_dashboard');
select throws_ok($$ select count(*) from lk.daily $$, '42501', 'permission denied for schema lk', 'G1 authenticated: lk schema closed');
reset role;

select ok(not has_function_privilege(r, f, 'execute'), format('G1 %s: %s denied', r, f))
  from unnest(array['anon', 'authenticated']) as r,
       unnest(array[
         'public.lk_worker_context()', 'public.lk_set_deployment(integer, jsonb)',
         'public.lk_enqueue(integer, integer, jsonb, jsonb)', 'public.lk_pending(integer, integer, integer, text)',
         'public.lk_ingest(integer, integer, jsonb, text[], boolean)', 'public.lk_mark_attempt(integer, integer, text, text, text)',
         'public.lk_open_gaps(integer, integer, integer)', 'public.lk_reparse_candidates(integer, integer, integer, integer)',
         'public.lk_write_state(integer, bigint, jsonb, jsonb, timestamptz)', 'public.lk_heartbeat(text, jsonb)',
         'public.lk_report_run(integer, integer, jsonb)', 'public.lk_compact(integer)', 'public.lk_verify(integer, integer)',
         'public.lk_verify_counts(integer)', 'public.lk_start_build(integer, integer)',
         'public.lk_promote_build(integer, integer)']) as f;
select ok(has_function_privilege('service_role', f, 'execute'), format('G1 service_role: %s granted', f))
  from unnest(array['public.lk_worker_context()', 'public.lk_ingest(integer, integer, jsonb, text[], boolean)',
                    'public.lk_heartbeat(text, jsonb)', 'public.lk_dashboard(text, text)']) as f;
select ok(not has_schema_privilege(r, 'lk', 'usage'), format('G1 %s: no usage on schema lk', r))
  from unnest(array['anon', 'authenticated', 'service_role']) as r;

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
