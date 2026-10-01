-- Core write path: idempotence (P1-P3), the judges' regressions (T1-T3), sealing (S1), the queue (Q1),
-- gaps (Q2), the recompute check (V) and u32 error codes (E1). Everything runs in one rolled-back transaction.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ------------------------------------------------------------------------------------------------ helpers
create function pg_temp.reset() returns void language sql as $$
  delete from lk.events; delete from lk.daily; delete from lk.actor_days; delete from lk.wallets;
  delete from lk.pending; delete from lk.gaps; delete from lk.deploys; delete from lk.state_current;
  delete from lk.builds where gen > 1;
  update lk.builds set status = 'active', frontier_slot = null, frontier_signature = null, frontier_block_time = null,
         discovered_at = null, history_end_reached = false, history_start_signature = null, history_proof = null,
         backfill_complete = false, backfill_completed_at = null, first_activity_at = null, ingested_sigs = 0,
         compacted_before = null;
  update lk.programs set active_gen = 1;
$$;

-- one event row
create function pg_temp.ev(sig text, seq int, slot bigint, t timestamptz, kind int, ok boolean, wallet text,
                           extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('signature', sig, 'ix_seq', seq, 'slot', slot, 'block_time', t, 'kind', kind,
                            'ok', ok, 'wallet', wallet, 'payer', 'PAYER', 'parser_version', 1) || extra
$$;

-- 30 synthetic signatures of program 4 over ~3 days: mixed kinds, failures, fees, apps, CPIs, multi-ix txs
create function pg_temp.dataset() returns table (i int, sig text, rows jsonb) language sql as $$
  select i, 'P' || lpad(i::text, 3, '0'),
         jsonb_build_array(pg_temp.ev('P' || lpad(i::text, 3, '0'), 0, 1000 + i,
             timestamptz '2026-09-20 00:00:00+00' + i * interval '2 hours 13 minutes',
             (array[0, 4, 6, 7, 4, 5, 9, 4, 254, 255])[1 + i % 10], i % 7 <> 0, 'W' || (i % 6),
             jsonb_build_object(
               'fail_class', case when i % 7 = 0 then 'lazorkit' end,
               'payer', 'PAY' || (i % 3), 'auth', (array[1, 2, 3, 4])[1 + i % 4],
               'fee_lamports', case when i % 3 = 0 and i % 7 <> 0 then 5000 else 0 end,
               'app', case when i % 4 = 0 then 'app' || (i % 3) end,
               'cpi', case when i % 10 in (1, 4, 7) then jsonb_build_array('11111111111111111111111111111111') end,
               'ref', 'V' || (i % 6), 'tx_version', i % 2, 'net_fee_lamports', 5000)))
         || case when i % 5 = 0 then jsonb_build_array(pg_temp.ev('P' || lpad(i::text, 3, '0'), 1, 1000 + i,
               timestamptz '2026-09-20 00:00:00+00' + i * interval '2 hours 13 minutes', 4, i % 7 <> 0, 'W9',
               jsonb_build_object('inner_ix', true, 'auth', 2, 'payer', 'PAY0')))
            else '[]'::jsonb end
    from generate_series(1, 30) as i
$$;

create function pg_temp.batch(p int, i0 int, i1 int, replace boolean default false) returns jsonb language sql as $$
  select public.lk_ingest(p, 1,
    (select jsonb_agg(e order by d.i) from pg_temp.dataset() d cross join lateral jsonb_array_elements(d.rows) e
      where d.i between i0 and i1),
    (select array_agg(d.sig order by d.i) from pg_temp.dataset() d where d.i between i0 and i1),
    replace)
$$;

create function pg_temp.fp(p int) returns text language sql as $$
  select md5(
    coalesce((select string_agg((to_jsonb(d) - 'computed_at')::text, '|' order by d.gen, d.day)
                from lk.daily d where d.program_key = p), '') || '#' ||
    coalesce((select string_agg(a.gen || a.day::text || a.role || a.actor, '|' order by a.gen, a.day, a.role, a.actor)
                from lk.actor_days a where a.program_key = p), '') || '#' ||
    coalesce((select string_agg(to_jsonb(w)::text, '|' order by w.gen, w.wallet)
                from lk.wallets w where w.program_key = p), '') || '#' ||
    coalesce((select string_agg(b.ingested_sigs || '/' || coalesce(b.first_activity_at::text, ''), '|' order by b.gen)
                from lk.builds b where b.program_key = p), ''))
$$;

create function pg_temp.final(p int, g int, frontier bigint, history_end boolean, discovered timestamptz default now())
returns jsonb language sql as $$
  select public.lk_enqueue(p, g, '[]'::jsonb, jsonb_build_object('frontier_slot', frontier, 'frontier_signature', 'F',
           'frontier_block_time', now(), 'discovered_at', discovered, 'history_end', history_end))
$$;

-- ------------------------------------------------------------------------------------------------ P1-P3
select pg_temp.reset();
select pg_temp.batch(4, 1, 10); select pg_temp.batch(4, 11, 20); select pg_temp.batch(4, 21, 30);
create temp table fp_ref as select pg_temp.fp(4) as v;
select ok((select count(*) from lk.daily where program_key = 4) >= 3, 'P0: the dataset spans several days');
select is((select ingested_sigs from lk.builds where program_key = 4 and gen = 1), 30::bigint, 'P0: 30 signatures ingested');

select pg_temp.batch(4, 1, 10); select pg_temp.batch(4, 11, 20); select pg_temp.batch(4, 21, 30);
select is(pg_temp.fp(4), (select v from fp_ref), 'P1: replaying every batch leaves daily/actor_days/wallets/builds unchanged');

select pg_temp.reset();
select pg_temp.batch(4, s, least(s + 6, 30)) from generate_series(1, 30, 4) as s;
select is(pg_temp.fp(4), (select v from fp_ref), 'P2: overlapping 7-signature batches give the same state');

select pg_temp.reset();
select pg_temp.batch(4, 21, 30); select pg_temp.batch(4, 11, 20); select pg_temp.batch(4, 1, 10);
select is(pg_temp.fp(4), (select v from fp_ref), 'P3a: batches newest -> oldest give the same state');

select pg_temp.reset();
select pg_temp.batch(4, s, s) from generate_series(30, 1, -1) as s;
select is(pg_temp.fp(4), (select v from fp_ref), 'P3b: one signature at a time, newest -> oldest, gives the same state');

select pg_temp.batch(4, 3, 17, true);
select is(pg_temp.fp(4), (select v from fp_ref), 'P4: a reparse (replace) of identical rows changes nothing');

-- ------------------------------------------------------------------------------------------------ V
select is((public.lk_verify(4, 1) ->> 'mismatches')::int, 0, 'V: lk_verify finds no mismatch after P1-P3');
update lk.daily set txs = txs + 1 where program_key = 4 and day = '2026-09-21';
select ok((public.lk_verify(4, 1) ->> 'mismatches')::int > 0, 'V: lk_verify detects a tampered daily row');
select is((select c ->> 'ok' from lk.programs p, jsonb_array_elements(p.checks) c where p.program_key = 4 and c ->> 'id' = 'R1'),
          'false', 'V: the R1 check is recorded on the program');
select lk.recompute_days(4, 1, array['2026-09-21'::date]);
select is((public.lk_verify(4, 1) ->> 'mismatches')::int, 0, 'V: a recompute repairs it');

-- ------------------------------------------------------------------------------------------------ T1
select pg_temp.reset();
select public.lk_ingest(3, 1, jsonb_build_array(
  pg_temp.ev('t1a', 0, 100, '2026-05-01T10:00:00Z', 0, true, 'W1'),
  pg_temp.ev('t1b', 0, 101, '2026-05-01T10:05:00Z', 4, true, 'W1', '{"fee_lamports": 5000}')), array['t1a', 't1b']);
select public.lk_compact(35);
select is((select count(*)::int from lk.daily where program_key = 3 and sealed), 0,
          'T1: nothing of an unfinished backfill is sealed');
select lives_ok($$ select public.lk_ingest(3, 1, jsonb_build_array(
  pg_temp.ev('t1c', 0, 102, '2026-05-01T12:00:00Z', 4, true, 'W2')), array['t1c']) $$,
  'T1: the next backfill batch on the same old day succeeds');
select is((select txs from lk.daily where program_key = 3 and day = '2026-05-01'), 3, 'T1: the day holds all three');
select pg_temp.final(3, 1, 102, false);
select public.lk_compact(35);
select is((select count(*)::int from lk.daily where program_key = 3 and sealed), 0,
          'T1: still unsealed while the history end is not reached');
select pg_temp.final(3, 1, 102, true);
select ok((select backfill_complete from lk.builds where program_key = 3 and gen = 1), 'T1: history end + empty queue completes the backfill');
select public.lk_compact(35);
select is((select count(*)::int from lk.daily where program_key = 3 and sealed and day = '2026-05-01'), 1,
          'T1: then the old day is sealed');
select is((select count(*)::int from lk.events where program_key = 3 and block_time < now() - interval '35 days'), 0,
          'T1: and its events are deleted');
select is((select compacted_before from lk.builds where program_key = 3 and gen = 1), current_date - 35,
          'T1: compacted_before records the horizon');

-- ------------------------------------------------------------------------------------------------ S1
select throws_like($$ select public.lk_ingest(3, 1, jsonb_build_array(
  pg_temp.ev('s1a', 0, 99, '2026-05-01T09:00:00Z', 4, true, 'W3')), array['s1a']) $$,
  '%refusing to rewrite a sealed day%', 'S1: ingest into a sealed day raises');
select is((select count(*)::int from lk.events where signature = 's1a'), 0, 'S1: and rolls back');
select throws_like($$ select public.lk_compact(30) $$, '%at least 31 days%', 'S1: lk_compact(30) raises (the 30d comparison reads events)');
select is((public.lk_enqueue(3, 1, '[{"signature":"old","slot":50,"block_time":"2026-04-30T00:00:00Z"}]', null) ->> 'queued')::int,
          0, 'S1: discovery of a signature on a compacted day is skipped');

-- ------------------------------------------------------------------------------------------------ T2
select pg_temp.reset();
select public.lk_ingest(1, 1, jsonb_build_array(pg_temp.ev('a1', 0, 200, '2026-05-02T10:00:00Z', 4, true, 'WA',
         '{"fee_lamports": 5000}')), array['a1']);
select public.lk_ingest(2, 1, jsonb_build_array(pg_temp.ev('b1', 0, 201, '2026-05-02T11:00:00Z', 4, true, 'WB',
         '{"fee_lamports": 7000}')), array['b1']);
select pg_temp.final(1, 1, 200, true, now() - interval '1 minute');
select pg_temp.final(2, 1, 201, true, now() - interval '1 minute');
select public.lk_compact(35);
select is((select count(*)::int from lk.daily where program_key in (1, 2) and sealed), 2, 'T2: both programs sealed');
select is(public.lk_start_build(1, 2), 2, 'T2: lk_start_build creates generation 2');
select throws_like($$ select public.lk_start_build(1, 2) $$, '%already has a building generation%',
                   'T2: only one building generation');
select lives_ok($$ select public.lk_ingest(1, 2, jsonb_build_array(pg_temp.ev('a1', 0, 200, '2026-05-02T10:00:00Z', 4,
         true, 'WA', '{"fee_lamports": 6000, "parser_version": 2}')), array['a1']) $$,
  'T2: the rebuild ingests a day that is sealed for the active generation');
select throws_like($$ select public.lk_promote_build(1, 2) $$, '%has not finished its backfill%',
                   'T2: promotion needs a complete backfill');
select pg_temp.final(1, 2, 200, true, now());
select is(public.lk_promote_build(1, 2) ->> 'promoted', '2', 'T2: promoted');
select is((select active_gen from lk.programs where program_key = 1), 2::smallint, 'T2: active generation is 2');
select is((select count(*)::int from lk.events where program_key = 1 and gen = 1) +
          (select count(*)::int from lk.daily where program_key = 1 and gen = 1), 0, 'T2: generation 1 rows are deleted');
select is((select status from lk.builds where program_key = 1 and gen = 1), 'retired', 'T2: generation 1 is retired');
select is(public.lk_dashboard('mainnet', 'all') #>> '{kpis,cluster,current,feeLamports}', '13000',
          'T2: the cluster reads gen-2 v1 (6000) + v2 (7000)');
select is((public.lk_dashboard('mainnet', 'all') #>> '{kpis,cluster,current,txs}')::int, 2, 'T2: cluster txs = 2');

-- ------------------------------------------------------------------------------------------------ T3
select pg_temp.reset();
select public.lk_ingest(4, 1, jsonb_build_array(pg_temp.ev('c1', 0, 300, now() - interval '1 day', 4, true, 'WRONG')),
                        array['c1']);
select public.lk_ingest(4, 1, jsonb_build_array(pg_temp.ev('c1', 0, 300, now() - interval '1 day', 4, true, 'RIGHT',
                        '{"parser_version": 2}')), array['c1'], true);
select is((select string_agg(actor, ',' order by actor) from lk.actor_days where program_key = 4 and role = 'w'),
          'RIGHT', 'T3: actor_days holds only the reparsed wallet');
select is((select count(*)::int from lk.wallets where program_key = 4), 0, 'T3: no orphan wallet row');
select is((public.lk_dashboard('devnet', '7d') #>> '{kpis,4,current,activeWallets}')::int, 1, 'T3: 7d active wallets = 1');
select is((public.lk_dashboard('devnet', 'all') #>> '{kpis,4,current,activeWallets}')::int, 1, 'T3: all active wallets = 1');
select is((select parser_version_min from lk.daily where program_key = 4), 2::smallint, 'T3: parser_version_min follows the reparse');
-- a reparse that changes a CreateWallet's vault moves the wallet fact too
select public.lk_ingest(4, 1, jsonb_build_array(pg_temp.ev('c2', 0, 301, now() - interval '1 day', 0, true, 'WX',
                        '{"ref": "VAULT_WRONG"}')), array['c2']);
select public.lk_ingest(4, 1, jsonb_build_array(pg_temp.ev('c2', 0, 301, now() - interval '1 day', 0, true, 'WY',
                        '{"ref": "VAULT_RIGHT"}')), array['c2'], true);
select is((select string_agg(wallet || ':' || vault, ',') from lk.wallets where program_key = 4), 'WY:VAULT_RIGHT',
          'T3: wallet facts follow the reparse');

-- ------------------------------------------------------------------------------------------------ Q1
select pg_temp.reset();
select is((public.lk_enqueue(4, 1, '[{"signature":"q1","slot":500,"block_time":"2026-09-29T00:00:00Z"},
                                     {"signature":"q2","slot":501,"block_time":"2026-09-29T00:01:00Z","err":{"x":1}}]', null)
          ->> 'queued')::int, 2, 'Q1: signatures are queued');
select is((select frontier_slot from lk.builds where program_key = 4 and gen = 1), null::bigint,
          'Q1: the frontier does not move without p_final');
select pg_temp.final(4, 1, 501, false);
select is((select frontier_slot from lk.builds where program_key = 4 and gen = 1), 501::bigint, 'Q1: p_final moves the frontier');
select pg_temp.final(4, 1, 400, false);
select is((select frontier_slot from lk.builds where program_key = 4 and gen = 1), 501::bigint, 'Q1: it never moves backward');
select is((public.lk_enqueue(4, 1, '[{"signature":"q1","slot":500,"block_time":"2026-09-29T00:00:00Z"}]', null)
          ->> 'queued')::int, 0, 'Q1: an already queued signature is not queued twice');
select is(jsonb_array_length(public.lk_pending(4, 1, 10, 'run-a')), 2, 'Q1: lk_pending returns the queue');
select is(public.lk_pending(4, 1, 10, 'run-a') -> 0 ->> 'signature', 'q1', 'Q1: oldest first');
select public.lk_ingest(4, 1, jsonb_build_array(pg_temp.ev('q1', 0, 500, '2026-09-29T00:00:00Z', 255, true, null,
                        '{"flags": 3, "ref": "deploy"}')), array['q1']);
select is((public.lk_enqueue(4, 1, '[{"signature":"q1","slot":500,"block_time":"2026-09-29T00:00:00Z"}]', null)
          ->> 'queued')::int, 0, 'Q1: a signature already in events is skipped');
select pg_temp.final(4, 1, 501, true);
select ok(not (select backfill_complete from lk.builds where program_key = 4 and gen = 1),
          'Q1: history end with a non-empty queue is not complete');
select public.lk_ingest(4, 1, jsonb_build_array(pg_temp.ev('q2', 0, 501, '2026-09-29T00:01:00Z', 4, false, 'W',
                        '{"fail_class": "lazorkit"}')), array['q2']);
select ok((select backfill_complete from lk.builds where program_key = 4 and gen = 1),
          'Q1: history end + empty queue completes the backfill');
select is((select history_proof from lk.builds where program_key = 4 and gen = 1), 'deploy_tx',
          'Q1: history_proof is deploy_tx when the HISTORY_START row was ingested');
select is((select history_start_signature from lk.builds where program_key = 4 and gen = 1), 'q1', 'Q1: history start recorded');
select is((select op from lk.deploys where program_key = 4 and signature = 'q1'), 'deploy', 'Q1: loader op recorded in lk.deploys');
select throws_like($$ select public.lk_ingest(4, 1, jsonb_build_array(pg_temp.ev('q3', 1, 502, now(), 4, true, 'W')), array['q3']) $$,
                   '%no ix_seq 0 row%', 'Q1: a signature without an ix_seq 0 row is refused');
select throws_like($$ select public.lk_ingest(4, 1, jsonb_build_array(pg_temp.ev('q3', 0, 502, now(), 4, true, 'W')), array['q4']) $$,
                   '%no ix_seq 0 row%', 'Q1: a listed signature without rows is refused');
select pg_temp.reset();
select pg_temp.final(2, 1, null, true);
select is((select history_proof from lk.builds where program_key = 2 and gen = 1), 'archival_end',
          'Q1: an empty history ends with proof archival_end');

-- ------------------------------------------------------------------------------------------------ Q2
select pg_temp.reset();
select public.lk_enqueue(4, 1, jsonb_build_array(jsonb_build_object('signature', 'g1', 'slot', 600,
         'block_time', now() - interval '2 days')), null);
select public.lk_mark_attempt(4, 1, 'g1', 'run-1', 'not_found_on_any_endpoint');
select public.lk_mark_attempt(4, 1, 'g1', 'run-1', 'not_found_on_any_endpoint');
select is((select attempts from lk.pending where signature = 'g1'), 1::smallint, 'Q2: failures within one run count once');
select is(jsonb_array_length(public.lk_pending(4, 1, 10, 'run-1')), 0, 'Q2: a signature is tried once per run');
select public.lk_mark_attempt(4, 1, 'g1', 'run-' || r, 'not_found_on_any_endpoint') from generate_series(2, 4) as r;
select is((select count(*)::int from lk.events where signature = 'g1'), 0, 'Q2: 4 failed runs: still pending');
select is((public.lk_mark_attempt(4, 1, 'g1', 'run-5', 'not_found_on_any_endpoint') ->> 'converted'), 'true',
          'Q2: the 5th failed run converts it to a gap');
select is((select kind from lk.events where signature = 'g1'), 253::smallint, 'Q2: a kind=253 ledger row');
select is((select count(*)::int from lk.pending where signature = 'g1'), 0, 'Q2: no longer pending');
select is((select reason from lk.gaps where signature = 'g1'), 'not_found_on_any_endpoint', 'Q2: gap recorded with reason');
select is((select unparsed_txs || '/' || txs || '/' || sigs from lk.daily where program_key = 4), '1/0/1',
          'Q2: counted as unparsed, not as a transaction');
select is(jsonb_array_length(public.lk_open_gaps(4, 1, 10)), 1, 'Q2: listed by lk_open_gaps');
select public.lk_ingest(4, 1, jsonb_build_array(pg_temp.ev('g1', 0, 600, now() - interval '2 days', 4, true, 'WG')),
                        array['g1'], true);
select is((select kind from lk.events where signature = 'g1'), 4::smallint, 'Q2: repair replaces the 253 row');
select ok((select resolved_at is not null from lk.gaps where signature = 'g1'), 'Q2: and resolves the gap');
select is((select unparsed_txs || '/' || txs from lk.daily where program_key = 4), '0/1', 'Q2: the day is recomputed');
select is((select ingested_sigs from lk.builds where program_key = 4 and gen = 1), 1::bigint, 'Q2: repair does not double count');
-- an open gap holds compaction of its day back for 30 days
select public.lk_enqueue(4, 1, jsonb_build_array(jsonb_build_object('signature', 'g2', 'slot', 590,
         'block_time', '2026-05-03T00:00:00Z')), null);
select public.lk_mark_attempt(4, 1, 'g2', 'gap-run-' || r, 'rpc_error:-32009') from generate_series(1, 5) as r;
select pg_temp.final(4, 1, 600, true);
select public.lk_compact(35);
select is((select sealed from lk.daily where program_key = 4 and day = '2026-05-03'), false, 'Q2: an open gap blocks sealing');
update lk.gaps set first_seen_at = now() - interval '31 days' where signature = 'g2';
select public.lk_compact(35);
select is((select sealed from lk.daily where program_key = 4 and day = '2026-05-03'), true,
          'Q2: after 30 days the gap is abandoned and the day is sealed');
select is(jsonb_array_length(public.lk_open_gaps(4, 1, 10)), 0, 'Q2: gaps on sealed days are not retried');

-- ------------------------------------------------------------------------------------------------ E1
-- A Solana Custom error code is a u32: the largest one must not overflow err_code (it used to reject the batch).
select pg_temp.reset();
select lives_ok($$ select public.lk_ingest(4, 1, jsonb_build_array(pg_temp.ev('e1', 0, 700, now() - interval '1 hour',
         4, false, 'WE', '{"fail_class": "other_ix", "err_code": 4294967295}')), array['e1']) $$,
         'E1: err_code 4294967295 (u32 max) is accepted');
select is((select err_code from lk.events where signature = 'e1'), 4294967295::bigint, 'E1: and stored exactly');
select is((public.lk_dashboard('devnet', '24h') #>> '{latest,0,errCode}')::bigint, 4294967295::bigint,
          'E1: and served in latest activity');
select is((select data_type from information_schema.columns
            where table_schema = 'lk' and table_name = 'events' and column_name = 'err_code'), 'bigint',
          'E1: err_code is bigint');

select * from finish();
rollback;
