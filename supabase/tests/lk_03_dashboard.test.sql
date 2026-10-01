-- Read path: cluster de-duplication (C1), window edges (C2), same-span comparison (C3), integrators (C4), latest
-- per program (C5), shared failure classes (C6), invariants (I), payload shape.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

create function pg_temp.reset() returns void language sql as $$
  delete from lk.events; delete from lk.daily; delete from lk.actor_days; delete from lk.wallets;
  delete from lk.pending; delete from lk.gaps; delete from lk.deploys; delete from lk.state_current;
  delete from lk.heartbeats; delete from lk.builds where gen > 1;
  update lk.builds set status = 'active', frontier_slot = null, discovered_at = null, history_end_reached = false,
         history_start_signature = null, history_proof = null, backfill_complete = false, first_activity_at = null,
         ingested_sigs = 0, compacted_before = null;
  update lk.programs set active_gen = 1, deploy_status = 'live', checks = '[]';
$$;

create function pg_temp.ev(sig text, seq int, slot bigint, t timestamptz, kind int, ok boolean, wallet text,
                           extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('signature', sig, 'ix_seq', seq, 'slot', slot, 'block_time', t, 'kind', kind,
                            'ok', ok, 'wallet', wallet, 'payer', 'PAYER', 'parser_version', 1) || extra
$$;

create function pg_temp.one(p int, e jsonb) returns jsonb language sql as $$
  select public.lk_ingest(p, 1, jsonb_build_array(e), array[e ->> 'signature'])
$$;

-- ------------------------------------------------------------------------------------------------ C1
select pg_temp.reset();
-- one transaction carrying v1 MigrateWallet (program 1) and v2 CreateWallet (program 2): in both feeds
select pg_temp.one(1, pg_temp.ev('X', 0, 10, now() - interval '1 day', 17, true, 'V1W',
         '{"shared": true, "ref": "V2VAULT", "amount_lamports": 1000, "tokens": 2, "payer": "RELAY"}'));
select pg_temp.one(2, pg_temp.ev('X', 0, 10, now() - interval '1 day', 0, true, 'V2W',
         '{"shared": true, "ref": "V2VAULT", "fee_lamports": 5000, "payer": "RELAY"}'));
select pg_temp.one(2, pg_temp.ev('Y', 0, 11, now() - interval '1 day', 4, false, 'V2W',
         '{"fail_class": "lazorkit", "payer": "RELAY"}'));
select is((public.lk_dashboard('mainnet', 'all') #>> '{kpis,cluster,current,txs}')::int, 2,
          'C1: the shared transaction counts once in the cluster (X + Y)');
select is((public.lk_dashboard('mainnet', 'all') #>> '{kpis,cluster,current,signatures}')::int, 2, 'C1: signatures too');
select is((public.lk_dashboard('mainnet', 'all') #>> '{kpis,1,current,txs}')::int +
          (public.lk_dashboard('mainnet', 'all') #>> '{kpis,2,current,txs}')::int, 3, 'C1: per program it counts in both');
select is(public.lk_dashboard('mainnet', 'all') #>> '{kpis,cluster,current,feeLamports}', '5000', 'C1: fees are summed');
select is((public.lk_dashboard('mainnet', 'all') #>> '{kpis,cluster,current,activeWallets}')::int, 2,
          'C1: active wallets are summed (disjoint v1/v2 PDAs)');
select is((public.lk_dashboard('mainnet', 'all') #>> '{kpis,cluster,current,payers}')::int, 1,
          'C1: payers are distinct across programs');
select is((public.lk_dashboard('mainnet', '7d') #>> '{kpis,cluster,current,txs}')::int, 2, 'C1: the 7d window de-duplicates too');
select is((public.lk_dashboard('mainnet', '24h') #>> '{kpis,cluster,current,txs}')::int, 0, 'C1: nothing in the last 24h');
select is((public.lk_dashboard('mainnet', 'all') #>> '{migration,totals,migrations}')::int, 1, 'C1: migration totals');
select is((public.lk_dashboard('mainnet', 'all') #>> '{migration,status}'), 'active', 'C1: migration active once migrations > 0');
select is((public.lk_dashboard('mainnet', 'all') #>> '{migration,v2WalletsFromMigration}')::int, 1,
          'C1: the v2 wallet whose vault received a migration counts as migrated');
select is((select count(*)::int from jsonb_array_elements(public.lk_dashboard('mainnet', 'all') -> 'latest')), 3,
          'C1: latest lists one row per (program, signature)');
select is((public.lk_dashboard('mainnet', 'all') #>> '{kpis,cluster,current,failByClass,lazorkit}')::int, 1,
          'C1: failures by class');

-- ------------------------------------------------------------------------------------------------ C2
select pg_temp.reset();
select pg_temp.one(4, pg_temp.ev('d0', 0, 20, lk.day_start(current_date) + interval '1 minute', 4, true, 'A'));
select pg_temp.one(4, pg_temp.ev('d6', 0, 21, lk.day_start(current_date - 6) + interval '1 minute', 4, true, 'B'));
select pg_temp.one(4, pg_temp.ev('d7', 0, 22, lk.day_start(current_date - 7), 4, true, 'C'));
select pg_temp.one(4, pg_temp.ev('d13', 0, 23, lk.day_start(current_date - 13) + interval '1 minute', 4, true, 'D'));
select pg_temp.one(4, pg_temp.ev('d14', 0, 24, lk.day_start(current_date - 14) + interval '1 minute', 4, true, 'E'));
select is((public.lk_dashboard('devnet', '7d') #>> '{kpis,4,current,txs}')::int, 2, 'C2: 7d = 7 calendar days incl. today');
select is((public.lk_dashboard('devnet', '7d') #>> '{kpis,4,previous,txs}')::int, 2,
          'C2: previous 7d = the 7 days before, up to the same time of day');
select is((public.lk_dashboard('devnet', '7d') #>> '{range,start}')::timestamptz, lk.day_start(current_date - 6), 'C2: range start');
select is((select count(*)::int from jsonb_array_elements(public.lk_dashboard('devnet', '7d') -> 'series') s
            where s ->> 'scope' = 'cluster'), 7, 'C2: 7 daily points per scope');
select is((select count(*)::int from jsonb_array_elements(public.lk_dashboard('devnet', '30d') -> 'series') s
            where s ->> 'scope' = '4'), 30, 'C2: 30 daily points for a program');
select is((public.lk_dashboard('devnet', '30d') #>> '{kpis,4,current,txs}')::int, 5, 'C2: 30d holds all five');
select is((public.lk_dashboard('devnet', '30d') #>> '{kpis,cluster,current,activeWallets}')::int, 5, 'C2: distinct wallets over 30d');
select is((select count(*)::int from jsonb_array_elements(public.lk_dashboard('devnet', '24h') -> 'series') s
            where s ->> 'scope' = 'cluster'), 24, 'C2: 24h = 24 hourly buckets');
select is(public.lk_dashboard('devnet', '24h') #>> '{range,bucket}', 'hour', 'C2: 24h buckets are hours');
select is(public.lk_dashboard('devnet', 'all') #>> '{range,previousStart}', null, 'C2: all has no previous period');
select is(public.lk_dashboard('devnet', 'all') -> 'kpis' -> 'cluster' -> 'previous', 'null'::jsonb, 'C2: all previous is null');
select is((public.lk_dashboard('devnet', 'all') #>> '{range,start}')::timestamptz, lk.day_start(current_date - 14),
          'C2: all starts at the first active day');
select throws_like($$ select public.lk_dashboard('localnet', '7d') $$, '%unsupported cluster%', 'C2: localnet refused');
select throws_like($$ select public.lk_dashboard('devnet', '90d') $$, '%unsupported window%', 'C2: unknown window refused');

-- ------------------------------------------------------------------------------------------------ C3
-- The previous period covers the same elapsed span as the current one: it ends exactly one period before now.
-- t_in / t_out lie on the day 7 days ago, before / after the current time of day (likewise for the hour 24h ago).
select pg_temp.reset();
select pg_temp.one(4, pg_temp.ev('w_in', 0, 30,
         lk.day_start(current_date - 7) + (now() - lk.day_start(current_date)) / 2, 4, true, 'WIN', '{"app": "a.example"}'));
select pg_temp.one(4, pg_temp.ev('w_out', 0, 31,
         now() - interval '7 days' + (lk.day_start(current_date + 1) - now()) / 2, 4, true, 'WOUT', '{"app": "b.example"}'));
select pg_temp.one(4, pg_temp.ev('h_in', 0, 32, now() - interval '24 hours' - interval '1 second', 4, true, 'HIN'));
select pg_temp.one(4, pg_temp.ev('h_out', 0, 33, now() - interval '24 hours' + interval '1 second', 4, true, 'HOUT'));
select is((public.lk_dashboard('devnet', '7d') #>> '{kpis,4,previous,txs}')::int, 1,
          'C3: previous 7d stops at the same time of day 7 days ago (the later part of that day is excluded)');
select is((public.lk_dashboard('devnet', '7d') #>> '{kpis,4,previous,activeWallets}')::int, 1,
          'C3: distinct wallets of the partial day come from its events');
select is((public.lk_dashboard('devnet', '7d') #>> '{kpis,cluster,previous,apps}')::int, 1,
          'C3: cluster apps of the partial day too');
select is((public.lk_dashboard('devnet', '7d') #>> '{range,previousEnd}')::timestamptz, now() - interval '7 days',
          'C3: range.previousEnd = now - 7 days');
select is((public.lk_dashboard('devnet', '30d') #>> '{range,previousEnd}')::timestamptz, now() - interval '30 days',
          'C3: range.previousEnd = now - 30 days');
select is((public.lk_dashboard('devnet', '24h') #>> '{kpis,4,previous,txs}')::int, 1,
          'C3: previous 24h ends exactly 24 hours before now');
select is((public.lk_dashboard('devnet', '24h') #>> '{range,previousEnd}')::timestamptz, now() - interval '24 hours',
          'C3: range.previousEnd = now - 24 hours');
select is(public.lk_dashboard('devnet', 'all') #>> '{range,previousEnd}', null, 'C3: all has no previous end');

-- ------------------------------------------------------------------------------------------------ C4
-- Integrators: the 10 biggest by created + ops, whatever their names. 12 apps over two days (a day keeps its top
-- 10), the biggest with the name that sorts last.
select pg_temp.reset();
select pg_temp.one(4, pg_temp.ev('app' || n, 0, 40 + n, now() - interval '3 days', 4, true, 'WA' || n,
         jsonb_build_object('app', chr(96 + n) || '.example')))
  from generate_series(1, 11) as n;
select pg_temp.one(4, pg_temp.ev('big' || n, 0, 60 + n, now() - interval '2 days', 4, true, 'WZ',
         '{"app": "zz-biggest.example"}'))
  from generate_series(1, 3) as n;
select pg_temp.one(4, pg_temp.ev('small', 0, 70, now() - interval '2 days', 4, true, 'WS', '{"app": "l.example"}'));
select is((select count(*)::int from jsonb_object_keys(lk.window_metrics(4, 1, '-infinity', lk.day_start(current_date + 1), false)
            -> 'by_app')), 12, 'C4: 12 apps in the window');
select is(public.lk_dashboard('devnet', 'all') #>> '{breakdowns,4,byApp,0,app}', 'zz-biggest.example',
          'C4: the biggest integrator is first even though it sorts last by name');
select is((public.lk_dashboard('devnet', 'all') #>> '{breakdowns,4,byApp,0,ops}')::int, 3, 'C4: with its 3 operations');
select is(jsonb_array_length(public.lk_dashboard('devnet', 'all') #> '{breakdowns,cluster,byApp}'), 10,
          'C4: still 10 entries');
select is(public.lk_dashboard('devnet', 'all') #>> '{breakdowns,cluster,byApp,0,app}', 'zz-biggest.example',
          'C4: cluster scope too');

-- ------------------------------------------------------------------------------------------------ C5
-- Latest activity keeps the 50 newest per program, so a quiet version is not crowded out by a busy one.
select pg_temp.reset();
select pg_temp.one(3, pg_temp.ev('old-v1', 0, 80, now() - interval '3 days', 4, true, 'W1'));
select pg_temp.one(4, pg_temp.ev('v2-' || n, 0, 100 + n, now() - interval '1 hour' + n * interval '1 second', 4, true, 'W2'))
  from generate_series(1, 60) as n;
select is((select count(*)::int from jsonb_array_elements(public.lk_dashboard('devnet', '7d') -> 'latest') l
            where l ->> 'version' = '1'), 1, 'C5: the v1 transaction is listed despite 60 newer v2 ones');
select is((select count(*)::int from jsonb_array_elements(public.lk_dashboard('devnet', '7d') -> 'latest') l
            where l ->> 'version' = '2'), 50, 'C5: 50 per program');
select is(public.lk_dashboard('devnet', '7d') #>> '{latest,0,signature}', 'v2-60', 'C5: newest first');

-- ------------------------------------------------------------------------------------------------ C6
-- A shared failed transaction keeps the class of the program whose instruction failed in the cluster total.
select pg_temp.reset();
-- the v2 instruction failed (InstructionError, flag 128): v1 sees other_ix, v2 a LazorKit error
select pg_temp.one(3, pg_temp.ev('sf1', 0, 90, now() - interval '2 days', 17, false, 'V1W',
         '{"shared": true, "fail_class": "other_ix", "err_code": 3001, "flags": 128}'));
select pg_temp.one(4, pg_temp.ev('sf1', 0, 90, now() - interval '2 days', 0, false, 'V2W',
         '{"shared": true, "fail_class": "lazorkit", "err_code": 3001, "flags": 128}'));
-- the v1 instruction failed: v1 a LazorKit error, v2 other_ix
select pg_temp.one(3, pg_temp.ev('sf2', 0, 91, now() - interval '2 days', 17, false, 'V1W',
         '{"shared": true, "fail_class": "lazorkit", "err_code": 3002, "flags": 128}'));
select pg_temp.one(4, pg_temp.ev('sf2', 0, 91, now() - interval '2 days', 0, false, 'V2W',
         '{"shared": true, "fail_class": "other_ix", "err_code": 3002, "flags": 128}'));
-- a transaction-level failure (no instruction index): the same class on both copies
select pg_temp.one(3, pg_temp.ev('sf3', 0, 92, now() - interval '2 days', 17, false, 'V1W',
         '{"shared": true, "fail_class": "limits"}'));
select pg_temp.one(4, pg_temp.ev('sf3', 0, 92, now() - interval '2 days', 0, false, 'V2W',
         '{"shared": true, "fail_class": "limits"}'));
select is(public.lk_dashboard('devnet', '7d') #> '{kpis,cluster,current,failByClass}', '{"lazorkit": 2, "limits": 1}'::jsonb,
          'C6: cluster classes: the failing program''s class, other_ix dropped, limits once');
select is((public.lk_dashboard('devnet', '7d') #>> '{kpis,cluster,current,txsFailed}')::int, 3, 'C6: three failed transactions');
select is(public.lk_dashboard('devnet', '7d') #> '{kpis,4,current,failByClass}',
          '{"lazorkit": 1, "other_ix": 1, "limits": 1}'::jsonb, 'C6: per program, each copy keeps its own class');
select is(public.lk_dashboard('devnet', '24h') #> '{kpis,cluster,current,failByClass}', '{}'::jsonb, 'C6: nothing in 24h');
select is(public.lk_dashboard('devnet', 'all') #> '{breakdowns,cluster,byFail}', '{"lazorkit": 2, "limits": 1}'::jsonb,
          'C6: the cluster breakdown matches');

-- ------------------------------------------------------------------------------------------------ I
select pg_temp.reset();
select pg_temp.one(4, pg_temp.ev('i1', 0, 100, now() - interval '3 hours', 0, true, 'W1'));
select pg_temp.one(4, pg_temp.ev('i2', 0, 101, now() - interval '2 hours', 0, true, 'W2'));
select pg_temp.one(4, pg_temp.ev('i3', 0, 102, now() - interval '2 hours', 1, true, 'W2'));
select pg_temp.one(4, pg_temp.ev('i4', 0, 103, now() - interval '1 hour', 5, true, 'W1'));
select pg_temp.one(4, pg_temp.ev('i5', 0, 104, now() - interval '1 hour', 5, false, 'W1', '{"fail_class":"duplicate"}'));
-- after the snapshot slot: must be excluded from H(x)
select pg_temp.one(4, pg_temp.ev('i6', 0, 900, now() - interval '1 minute', 0, true, 'W3'));
select public.lk_write_state(4, 500, '{"wallets": 2, "authorities": {"total": 3}, "sessions": {"total": 1},
  "deferred": {"total": 0}, "feeRecords": {"totalFeesPaid": "0"}, "treasury": {"shards": 0, "lamports": "0"}}'::jsonb,
  '{}'::jsonb, now() - interval '5 minutes');
select is((select c ->> 'mode' from jsonb_array_elements(lk.check_invariants(4)) c where c ->> 'id' = 'I1'), 'pending',
          'I: an incomplete backfill gives mode pending');
select public.lk_enqueue(4, 1, '[]', jsonb_build_object('frontier_slot', 900, 'discovered_at', now(), 'history_end', true));
select is((select string_agg(c ->> 'id' || '=' || (c ->> 'ok'), ',' order by c ->> 'id')
             from jsonb_array_elements(lk.check_invariants(4)) c), 'I1=true,I2=true,I4=true,I5=true,I6=true',
          'I: matching history and state give ok=true (slot > S excluded)');
select is((select c ->> 'mode' from jsonb_array_elements(lk.check_invariants(4)) c where c ->> 'id' = 'I1'), 'enforce',
          'I: v2 devnet checks are enforced');
select public.lk_write_state(4, 500, '{"wallets": 3, "authorities": {"total": 3}, "sessions": {"total": 1},
  "deferred": {"total": 0}, "feeRecords": {"totalFeesPaid": "0"}, "treasury": {"shards": 0, "lamports": "0"}}'::jsonb,
  '{}'::jsonb, now() - interval '5 minutes');
select is((select c ->> 'ok' from jsonb_array_elements(lk.check_invariants(4)) c where c ->> 'id' = 'I1'), 'false',
          'I: an off-by-one gives ok=false');
select is((public.lk_report_run(4, 1, jsonb_build_object('run_id', 'r1', 'started_at', now(), 'finished_at', now(),
          'status', 'ok', 'progress', true)) ->> 'status'), 'ok', 'I: lk_report_run reports ok with an empty queue');
select is((select c ->> 'ok' from lk.programs p, jsonb_array_elements(p.checks) c where p.program_key = 4 and c ->> 'id' = 'I1'),
          'false', 'I: lk_report_run stores the checks');
select is((select count(*)::int from jsonb_array_elements(public.lk_dashboard('devnet', '7d') -> 'programs') p
            where p ->> 'programKey' = '4' and jsonb_array_length(p -> 'checks') > 0), 1, 'I: checks reach the payload');

-- report_run: no progress on a non-empty queue for 3 runs fails the program
select public.lk_enqueue(4, 1, '[{"signature":"stuck","slot":950,"block_time":"2026-09-30T00:00:00Z"}]', null);
select public.lk_report_run(4, 1, jsonb_build_object('run_id', 'r' || n, 'status', 'ok', 'progress', false))
  from generate_series(2, 3) as n;
select is((select last_run_status from lk.programs where program_key = 4), 'lagging', 'I: pending without progress: lagging');
select is((public.lk_report_run(4, 1, jsonb_build_object('run_id', 'r4', 'status', 'ok', 'progress', false)) ->> 'status'),
          'failed', 'I: the third run without progress fails');
select is((select consecutive_failures from lk.programs where program_key = 4), 1, 'I: consecutive failures counted');
select ok((select at is not null from lk.heartbeats where source = 'worker'), 'I: lk_report_run writes the worker heartbeat');

-- ------------------------------------------------------------------------------------------------ payload shape
select ok(public.lk_dashboard('devnet', '30d') ?& array['dbSchemaVersion', 'cluster', 'window', 'generatedAt', 'range',
          'programs', 'kpis', 'series', 'breakdowns', 'migration', 'binaries', 'latest', 'runs', 'heartbeats'],
          'payload: every top-level key of the contract');
select is((select count(*)::int from jsonb_array_elements(public.lk_dashboard('mainnet', '7d') -> 'binaries')), 3,
          'payload: mainnet known binaries (v1 full, v1 sunset, v2 release)');
select is(public.lk_dashboard('devnet', '7d') #>> '{programs,0,version}', '1', 'payload: programs ordered v1, v2');
select is(public.lk_health() ->> 'schemaVersion', '1', 'payload: lk_health reports the schema version');
select ok(public.lk_health() -> 'heartbeats' ? 'worker', 'payload: lk_health carries heartbeats');

-- deployment bookkeeping
update lk.programs set deploy_status = 'unknown' where program_key = 2;
select public.lk_set_deployment(2, '{"status": "not_deployed"}');
select is((select deploy_status from lk.programs where program_key = 2), 'not_deployed', 'deploy: not deployed');
select public.lk_set_deployment(2, '{"status": "live", "programdata": "PD", "deploy_slot": 7, "upgrade_authority": "AUTH",
  "sha256": "4cb8030466d269efa867f0ab2bc989cccd1857c2a753e67578267e4a6b144b12", "elf_size": 150776, "kind": "v2-full"}');
select is(public.lk_dashboard('mainnet', '7d') #>> '{programs,1,deployment,releaseMatch,feature}', 'mainnet',
          'deploy: v2 mainnet matches the mainnet release hash');
select is((select count(*)::int from lk.deploys where program_key = 2 and op = 'observed'), 1, 'deploy: observed deploy recorded');
select public.lk_set_deployment(2, '{"status": "not_deployed"}');
select is((select deploy_status from lk.programs where program_key = 2), 'closed', 'deploy: a live program that disappears is closed');
select public.lk_set_deployment(1, '{"status": "live", "deploy_slot": 9, "sha256": "ffff", "elf_size": 45000, "kind": "unknown"}');
select is(public.lk_dashboard('mainnet', '7d') #>> '{programs,0,deployment,binaryLabel}', 'unrecognised build (sunset-sized)',
          'deploy: an unknown small binary is labelled sunset-sized');

select * from finish();
rollback;
