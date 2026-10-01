-- LazorKit dashboard v2 backend: thin event log + daily rollups for protocol v1 and v2.
--
-- * Purely additive. It creates the schema "lk" and public.lk_* functions only. No legacy public.* table is
--   touched, so it can be applied at any time while the old site keeps serving.
-- * Re-runnable: create ... if not exists, create or replace function, seeds with on conflict do nothing.
--   Pasting it twice into the SQL editor does no damage.
-- * Postgres 15+ compatible (no any_value, IS JSON, MERGE ... RETURNING or JSON_TABLE).
-- * The tables live in "lk", which PostgREST does not expose. The API and the worker reach them only through
--   SECURITY DEFINER functions: readers are granted to anon/authenticated/service_role, writers to service_role.
-- * Every RPC parameter is integer, bigint, text, jsonb, boolean, text[] or timestamptz (never smallint).
--
-- Design notes: README.md "Backend" and the rebuild spec. In short:
--   lk.pending   durable discovery queue (every discovered signature, until ingested)
--   lk.events    one row per LazorKit instruction (top-level or inner), plus one row for a transaction without
--                one; doubles as the per-signature ledger; kept for INDEXER_EVENT_RETENTION_DAYS (35)
--   lk.daily     per (program, generation, UTC day) rollup, recomputed from events (never incremented), kept forever
--   lk.actor_days exact distinct wallets / payers / apps per day, kept forever
--   lk.wallets   wallet facts (creation, migration), pure functions of events
--   lk.builds    generations: a rebuild backfills a new generation beside the live one, then is promoted

begin;

create schema if not exists lk;
revoke all on schema lk from public;
revoke all on schema lk from anon, authenticated;

-- ============================================================================================== tables

create table if not exists lk.meta (
  key   text primary key,
  value text not null
);
insert into lk.meta (key, value) values ('schema_version', '1') on conflict (key) do nothing;

create table if not exists lk.programs (
  program_key          smallint primary key,
  cluster              text not null check (cluster in ('mainnet', 'devnet')),
  version              smallint not null check (version in (1, 2)),
  program_id           text not null unique,
  label                text not null,
  checks_mode          text not null default 'enforce' check (checks_mode in ('enforce', 'informational')),
  active_gen           smallint not null default 1,
  deploy_status        text not null default 'unknown'
                       check (deploy_status in ('unknown', 'not_deployed', 'live', 'closed')),
  programdata_address  text,
  last_deploy_slot     bigint,
  deployed_at          timestamptz,
  upgrade_authority    text,
  binary_sha256        text,
  elf_size             integer,
  binary_kind          text check (binary_kind in ('v1-full', 'v1-sunset', 'v2-full', 'unknown')),
  binary_checked_at    timestamptz,
  last_run_id          text,
  last_run_started_at  timestamptz,
  last_run_finished_at timestamptz,
  last_run_status      text not null default 'idle'
                       check (last_run_status in ('idle', 'ok', 'lagging', 'failed', 'not_deployed')),
  last_error           text,
  consecutive_failures integer not null default 0,
  no_progress_runs     integer not null default 0,
  last_success_at      timestamptz,
  checks               jsonb not null default '[]',
  checks_at            timestamptz,
  updated_at           timestamptz not null default now(),
  unique (cluster, version)
);
insert into lk.programs (program_key, cluster, version, program_id, label, checks_mode) values
  (1, 'mainnet', 1, 'LazorjRFNavitUaBu5m3WaNPjU1maipvSW2rZfAFAKi', 'v1 mainnet', 'enforce'),
  (2, 'mainnet', 2, 'LazorFroiVuAjcwwQ2me83vTr5nc5NRxSaTg3pmEXC8', 'v2 mainnet', 'enforce'),
  (3, 'devnet',  1, '4h3XoNReAgEcHVxcZ8sw2aufi9MTr7BbvYYjzjWDyDxS', 'v1 devnet',  'informational'),
  (4, 'devnet',  2, '57bTNWqtYTJbWuLWASKo6GqUTAK6oFDUR5c6hEc6V8nv', 'v2 devnet',  'enforce')
on conflict do nothing;

create table if not exists lk.builds (
  program_key             smallint not null references lk.programs,
  gen                     smallint not null,
  status                  text not null check (status in ('active', 'building', 'retired')),
  parser_version          smallint not null,
  created_at              timestamptz not null default now(),
  frontier_slot           bigint,       -- newest discovered slot. Invariant D: every signature with a lower slot
                                        -- is in lk.events or lk.pending
  frontier_signature      text,         -- informational only, never sent to an RPC
  frontier_block_time     timestamptz,
  discovered_at           timestamptz,  -- start of the last discovery whose results are all durably queued
  history_end_reached     boolean not null default false,
  history_start_signature text,         -- the program's DeployWithMaxDataLen, once ingested
  history_proof           text check (history_proof in ('deploy_tx', 'archival_end')),
  backfill_complete       boolean not null default false,
  backfill_completed_at   timestamptz,
  first_activity_at       timestamptz,  -- oldest real LazorKit instruction
  ingested_sigs           bigint not null default 0,
  compacted_before        date,         -- days before this are sealed and their events deleted (monotonic)
  promoted_at             timestamptz,
  retired_at              timestamptz,
  primary key (program_key, gen)
);
create unique index if not exists builds_one_active   on lk.builds (program_key) where status = 'active';
create unique index if not exists builds_one_building on lk.builds (program_key) where status = 'building';
insert into lk.builds (program_key, gen, status, parser_version, promoted_at)
select program_key, 1, 'active', 1, now() from lk.programs
on conflict do nothing;

create table if not exists lk.pending (
  program_key      smallint not null,
  gen              smallint not null,
  signature        text not null,
  slot             bigint not null,
  block_time       timestamptz not null,
  err              jsonb,
  discovered_at    timestamptz not null default now(),
  attempts         smallint not null default 0,
  last_attempt_run text,
  last_error       text,
  primary key (program_key, gen, signature),
  foreign key (program_key, gen) references lk.builds
);
create index if not exists pending_order_idx on lk.pending (program_key, gen, slot);

create table if not exists lk.events (
  program_key       smallint not null,
  gen               smallint not null,
  signature         text not null,
  ix_seq            smallint not null,     -- traversal order; every ingested signature has an ix_seq 0 row
  slot              bigint not null,
  block_time        timestamptz not null,
  kind              smallint not null,     -- 0..18 instruction; 253 unparsed (gap); 254 LazorKit ix with empty or
                                           -- unknown data (noise); 255 transaction without a LazorKit ix
  top_ix            smallint,
  inner_ix          boolean not null default false,
  ok                boolean not null,      -- transaction-level success
  fail_class        text,
  err_code          integer,
  wallet            text,
  payer             text,
  auth              smallint,              -- 1 passkey, 2 session, 3 ed25519, 4 deferred
  fee_lamports      bigint not null default 0,
  amount_lamports   bigint,
  tokens            smallint,
  ref               text,
  app               text,
  cpi               text[],
  tx_version        smallint,              -- -1 legacy, 0, 1
  net_fee_lamports  bigint,                -- meta.fee, on ix_seq 0 only
  shared            boolean not null default false,
  flags             integer not null default 0,
  parser_version    smallint not null,
  primary key (program_key, gen, signature, ix_seq),
  foreign key (program_key, gen) references lk.builds
);
create index if not exists events_time_idx on lk.events (program_key, gen, block_time desc);

create table if not exists lk.gaps (
  program_key     smallint not null,
  gen             smallint not null,
  signature       text not null,
  slot            bigint not null,
  block_time      timestamptz not null,
  err             jsonb,
  reason          text not null,
  attempts        smallint not null,
  first_seen_at   timestamptz not null default now(),
  last_attempt_at timestamptz,
  resolved_at     timestamptz,
  primary key (program_key, gen, signature)
);

create table if not exists lk.daily (
  program_key             smallint not null,
  gen                     smallint not null,
  day                     date not null,
  sigs                    integer not null,
  sigs_failed             integer not null,
  txs                     integer not null,
  txs_ok                  integer not null,
  txs_failed              integer not null,
  noise_txs               integer not null,
  unparsed_txs            integer not null,
  ixs                     integer not null,
  inner_ixs               integer not null,
  wallets_created         integer not null,
  wallets_created_passkey integer not null,
  active_wallets          integer not null,
  payers                  integer not null,
  executes                integer not null,
  fee_lamports            numeric(20, 0) not null,
  fee_events              integer not null,
  fee_eligible_ok         integer not null,
  fee_suffix_ok           integer not null,
  shard_funding_lamports  numeric(20, 0) not null,
  withdrawn_lamports      numeric(20, 0) not null,
  net_fee_lamports        numeric(20, 0) not null,
  migrations              integer not null,
  migrated_lamports       numeric(20, 0) not null,
  migrated_tokens         integer not null,
  cleanup_lamports        numeric(20, 0) not null,
  retired_calls           integer not null,
  txv1                    integer not null,
  shared_txs              integer not null,
  shared_txs_failed       integer not null,
  shared_txv1             integer not null,
  by_kind                 jsonb not null,
  by_auth                 jsonb not null,
  by_fail                 jsonb not null,
  shared_by_fail          jsonb not null,
  by_app                  jsonb not null,
  by_payer                jsonb not null,
  by_cpi                  jsonb not null,
  parser_version_min      smallint,
  sealed                  boolean not null default false,
  computed_at             timestamptz not null default now(),
  primary key (program_key, gen, day)
);

create table if not exists lk.actor_days (
  program_key smallint not null,
  gen         smallint not null,
  day         date not null,
  role        char(1) not null check (role in ('w', 'p', 'a')),
  actor       text not null,
  primary key (program_key, gen, day, role, actor)
);

create table if not exists lk.wallets (
  program_key       smallint not null,
  gen               smallint not null,
  wallet            text not null,
  vault             text,
  created_at        timestamptz,
  created_sig       text,
  owner_auth        smallint,
  rp_id             text,
  migrated_at       timestamptz,
  migrated_sig      text,
  migrated_to_vault text,
  migrated_lamports bigint,
  primary key (program_key, gen, wallet)
);
create index if not exists wallets_vault_idx    on lk.wallets (vault);
create index if not exists wallets_migrated_idx on lk.wallets (migrated_to_vault);

create table if not exists lk.known_binaries (
  sha256          text primary key,
  elf_size        integer not null,
  kind            text not null check (kind in ('v1-full', 'v1-sunset', 'v2-full')),
  cluster         text,
  release_feature text,
  label           text not null,
  source          text not null
);
insert into lk.known_binaries (sha256, elf_size, kind, cluster, release_feature, label, source) values
  ('8ad5abf5dd8a2443fea6b26b5effa9ce11477ce85ba9564f5c43663744c3255b', 137904, 'v1-full',   'mainnet', null,
   'v1 (mainnet build 2026-04-29)', 'program dump, docs/mainnet-deploy-checklist.md'),
  ('2bc794a82f91fb91ecf4a55fbb424ea6e72ef87fb9a752ee809a05d5180029c7', 161568, 'v1-full',   'devnet',  null,
   'v1 (devnet build 2026-04-28)',  'program dump (2026-10-01 probe)'),
  ('6080da9f28d194e36efbfbd6cf6d74389f2a68e232d4c323d153761c532a58a6',  45856, 'v1-sunset', 'mainnet', 'mainnet-v1',
   'v1 sunset (mainnet)',           'scripts/release-hashes.txt @ lazorkit-protocol develop 5fb8d46'),
  ('2cf15c89ad3ad194e5aebcab608dc4bc75270cb7d094d342a31ecdd3306f1240',  45856, 'v1-sunset', 'devnet',  'devnet-v1',
   'v1 sunset (devnet)',            'scripts/release-hashes.txt @ lazorkit-protocol develop 5fb8d46'),
  ('4cb8030466d269efa867f0ab2bc989cccd1857c2a753e67578267e4a6b144b12', 150776, 'v2-full',   'mainnet', 'mainnet',
   'v2 release (mainnet)',          'scripts/release-hashes.txt @ lazorkit-protocol develop 5fb8d46'),
  ('3584aec70e494e27521bf3e717ccc63bda295bb9d312cdcd4f9a007db249b470', 150776, 'v2-full',   'devnet',  'devnet',
   'v2 release (devnet)',           'scripts/release-hashes.txt @ lazorkit-protocol develop 5fb8d46')
on conflict do nothing;

create table if not exists lk.deploys (
  program_key       smallint not null references lk.programs,
  slot              bigint not null,
  op                text not null check (op in ('deploy', 'upgrade', 'extend', 'observed')),
  signature         text,
  block_time        timestamptz,
  upgrade_authority text,
  sha256            text,
  elf_size          integer,
  kind              text,
  detected_at       timestamptz not null default now(),
  primary key (program_key, slot, op)
);

create table if not exists lk.state_current (
  program_key smallint primary key references lk.programs,
  slot        bigint not null,
  fetched_at  timestamptz not null,
  totals      jsonb not null,
  detail      jsonb not null
);

create table if not exists lk.state_daily (
  program_key smallint not null references lk.programs,
  day         date not null,
  slot        bigint not null,
  totals      jsonb not null,
  primary key (program_key, day)
);

create table if not exists lk.heartbeats (
  source text primary key,
  at     timestamptz not null,
  detail jsonb not null default '{}'
);

create table if not exists lk.runs (
  run_id      text primary key,
  started_at  timestamptz not null,
  finished_at timestamptz,
  status      text,
  summary     jsonb
);

-- ============================================================================================== helpers

create or replace function lk.utc_day(t timestamptz) returns date
language sql immutable as $$ select (t at time zone 'utc')::date $$;

create or replace function lk.day_start(d date) returns timestamptz
language sql immutable as $$ select d::timestamp at time zone 'utc' $$;

create or replace function lk.lock(p integer, g integer) returns void
language sql as $$ select pg_advisory_xact_lock(hashtext('lk'), p * 100 + g) $$;

-- Recursive numeric addition of JSON values (numbers add, objects merge key by key).
create or replace function lk.jsonb_add(a jsonb, b jsonb) returns jsonb
language plpgsql immutable as $$
declare
  k text;
  r jsonb;
begin
  if a is null or jsonb_typeof(a) = 'null' then return b; end if;
  if b is null or jsonb_typeof(b) = 'null' then return a; end if;
  if jsonb_typeof(a) = 'number' and jsonb_typeof(b) = 'number' then
    return to_jsonb((a #>> '{}')::numeric + (b #>> '{}')::numeric);
  end if;
  if jsonb_typeof(a) = 'object' and jsonb_typeof(b) = 'object' then
    r := a;
    for k in select jsonb_object_keys(b) loop
      r := jsonb_set(r, array[k], lk.jsonb_add(a -> k, b -> k), true);
    end loop;
    return r;
  end if;
  return b;
end $$;

-- Multiplies every number inside a JSON value by f (used to subtract maps).
create or replace function lk.jsonb_scale(a jsonb, f numeric) returns jsonb
language plpgsql immutable as $$
declare
  k text;
  r jsonb;
begin
  if a is null then return null; end if;
  if jsonb_typeof(a) = 'number' then return to_jsonb((a #>> '{}')::numeric * f); end if;
  if jsonb_typeof(a) = 'object' then
    r := a;
    for k in select jsonb_object_keys(a) loop
      r := jsonb_set(r, array[k], lk.jsonb_scale(a -> k, f), true);
    end loop;
    return r;
  end if;
  return a;
end $$;

create or replace aggregate lk.jsonb_sum(jsonb) (sfunc = lk.jsonb_add, stype = jsonb);

-- Drops zero entries of a {key: number} map (and of {key: {ok, fail}} maps whose numbers are all zero).
create or replace function lk.jsonb_nonzero(a jsonb) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
    from jsonb_each(coalesce(a, '{}'::jsonb)) as e(k, v)
   where case jsonb_typeof(v)
           when 'number' then (v #>> '{}')::numeric <> 0
           when 'object' then exists (select 1 from jsonb_each(v) x(xk, xv)
                                       where jsonb_typeof(xv) = 'number' and (xv #>> '{}')::numeric <> 0)
           else true end
$$;

-- ============================================================================================== metric core
-- One pass over the events of (program, generation) in [t0, t1), grouped by bucket ('hour', 'day', or 'none' =
-- a single bucket starting at t0). Every flow metric of lk.daily is defined here and only here (spec §8.1);
-- lk.daily rows, the 24h window, hourly series and lk_verify all use it.
create or replace function lk.rollup(p integer, g integer, t0 timestamptz, t1 timestamptz, unit text)
returns table (bucket timestamptz, m jsonb)
language sql stable as $$
with ev as (
  select case when unit = 'none' then t0
              else date_trunc(unit, e.block_time at time zone 'utc') at time zone 'utc' end as b,
         e.*
    from lk.events e
   where e.program_key = p and e.gen = g and e.block_time >= t0 and e.block_time < t1
),
tx as (
  select b, signature,
         bool_or(kind <= 18)              as is_real,
         bool_or(kind = 253)              as is_unparsed,
         bool_and(ok)                     as ok,
         max(fail_class)                  as fail_class,
         max(tx_version)                  as tx_version,
         bool_or(shared)                  as shared,
         coalesce(max(net_fee_lamports), 0) as net_fee
    from ev
   group by b, signature
),
t as (
  select b,
         count(*)                                                    as sigs,
         count(*) filter (where not ok)                              as sigs_failed,
         count(*) filter (where is_real)                             as txs,
         count(*) filter (where is_real and ok)                      as txs_ok,
         count(*) filter (where is_real and not ok)                  as txs_failed,
         count(*) filter (where not is_real and not is_unparsed)     as noise_txs,
         count(*) filter (where is_unparsed)                         as unparsed_txs,
         count(*) filter (where is_real and not ok and fail_class = 'retired') as retired_calls,
         count(*) filter (where is_real and tx_version = 1)          as txv1,
         count(*) filter (where is_real and shared)                  as shared_txs,
         count(*) filter (where is_real and shared and not ok)       as shared_txs_failed,
         count(*) filter (where is_real and shared and tx_version = 1) as shared_txv1,
         coalesce(sum(net_fee) filter (where is_real), 0)            as net_fee_lamports
    from tx
   group by b
),
f as (
  select b,
         coalesce(jsonb_object_agg(fc, n) filter (where n > 0), '{}'::jsonb)   as by_fail,
         coalesce(jsonb_object_agg(fc, sn) filter (where sn > 0), '{}'::jsonb) as shared_by_fail
    from (select b, coalesce(fail_class, 'other') as fc, count(*) as n, count(*) filter (where shared) as sn
            from tx where is_real and not ok
           group by b, coalesce(fail_class, 'other')) x
   group by b
),
r as (
  select b,
         count(*) filter (where kind <= 18)                                           as ixs,
         count(*) filter (where kind <= 18 and inner_ix)                              as inner_ixs,
         count(*) filter (where ok and kind = 0)                                      as wallets_created,
         count(*) filter (where ok and kind = 0 and auth = 1)                         as wallets_created_passkey,
         count(distinct wallet) filter (where ok and kind in (0, 1, 2, 3, 4, 5, 6, 7, 9, 17)) as active_wallets,
         count(distinct payer) filter (where ok and kind in (0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 17, 18)) as payers,
         count(distinct app) filter (where ok)                                        as apps,
         count(*) filter (where ok and kind = 4)                                      as executes,
         coalesce(sum(fee_lamports) filter (where ok and kind in (0, 4, 7)), 0)       as fee_lamports,
         count(*) filter (where ok and kind in (0, 4, 7) and fee_lamports > 0)        as fee_events,
         count(*) filter (where ok and kind in (0, 4, 7))                             as fee_eligible_ok,
         count(*) filter (where ok and kind in (0, 4, 7) and (flags & 16) <> 0)       as fee_suffix_ok,
         coalesce(sum(amount_lamports) filter (where ok and kind = 14), 0)            as shard_funding_lamports,
         coalesce(sum(amount_lamports) filter (where ok and kind = 13), 0)            as withdrawn_lamports,
         count(*) filter (where ok and kind = 17)                                     as migrations,
         coalesce(sum(amount_lamports) filter (where ok and kind = 17), 0)            as migrated_lamports,
         coalesce(sum(tokens) filter (where ok and kind = 17), 0)                     as migrated_tokens,
         coalesce(sum(amount_lamports) filter (where ok and kind in (8, 18)), 0)      as cleanup_lamports,
         min(parser_version)                                                          as parser_version_min
    from ev
   group by b
),
k as (
  select b, jsonb_object_agg(kind::text, jsonb_build_object('ok', okc, 'fail', failc)) as by_kind
    from (select b, kind, count(*) filter (where ok) as okc, count(*) filter (where not ok) as failc
            from ev where kind <= 18 group by b, kind) x
   group by b
),
au as (
  select b, jsonb_object_agg(a, n) as by_auth
    from (select b,
                 case auth when 1 then 'passkey' when 2 then 'session' when 3 then 'ed25519'
                           when 4 then 'deferred' else 'unknown' end as a,
                 count(*) as n
            from ev where ok and kind in (4, 7)
           group by 1, 2) x
   group by b
),
ap as (
  select b, jsonb_object_agg(app, jsonb_build_object('created', created, 'ops', ops)) as by_app
    from (select b, app, created, ops,
                 row_number() over (partition by b order by created + ops desc, app) as rn
            from (select b, app, count(*) filter (where kind = 0) as created, count(*) filter (where kind <> 0) as ops
                    from ev where ok and app is not null group by b, app) y) x
   where rn <= 10
   group by b
),
py as (
  select b, jsonb_object_agg(payer, n) as by_payer
    from (select b, payer, n, row_number() over (partition by b order by n desc, payer) as rn
            from (select b, payer, count(distinct signature) as n
                    from ev where ok and kind <= 18 and payer is not null group by b, payer) y) x
   where rn <= 10
   group by b
),
cp as (
  select b, jsonb_object_agg(prog, n) as by_cpi
    from (select b, prog, n, row_number() over (partition by b order by n desc, prog) as rn
            from (select ev.b, c.prog, count(*) as n
                    from ev cross join lateral unnest(coalesce(ev.cpi, '{}'::text[])) as c(prog)
                   where ev.ok and ev.kind in (4, 7)
                   group by ev.b, c.prog) y) x
   where rn <= 10
   group by b
)
select t.b,
       jsonb_build_object(
         'sigs', t.sigs, 'sigs_failed', t.sigs_failed, 'txs', t.txs, 'txs_ok', t.txs_ok,
         'txs_failed', t.txs_failed, 'noise_txs', t.noise_txs, 'unparsed_txs', t.unparsed_txs,
         'retired_calls', t.retired_calls, 'txv1', t.txv1, 'shared_txs', t.shared_txs,
         'shared_txs_failed', t.shared_txs_failed, 'shared_txv1', t.shared_txv1,
         'net_fee_lamports', t.net_fee_lamports, 'ixs', r.ixs, 'inner_ixs', r.inner_ixs,
         'wallets_created', r.wallets_created, 'wallets_created_passkey', r.wallets_created_passkey,
         'active_wallets', r.active_wallets, 'payers', r.payers, 'apps', r.apps, 'executes', r.executes)
       || jsonb_build_object(
         'fee_lamports', r.fee_lamports, 'fee_events', r.fee_events, 'fee_eligible_ok', r.fee_eligible_ok,
         'fee_suffix_ok', r.fee_suffix_ok, 'shard_funding_lamports', r.shard_funding_lamports,
         'withdrawn_lamports', r.withdrawn_lamports, 'migrations', r.migrations,
         'migrated_lamports', r.migrated_lamports, 'migrated_tokens', r.migrated_tokens,
         'cleanup_lamports', r.cleanup_lamports, 'parser_version_min', r.parser_version_min,
         'by_kind', coalesce(k.by_kind, '{}'::jsonb), 'by_auth', coalesce(au.by_auth, '{}'::jsonb),
         'by_fail', coalesce(f.by_fail, '{}'::jsonb), 'shared_by_fail', coalesce(f.shared_by_fail, '{}'::jsonb),
         'by_app', coalesce(ap.by_app, '{}'::jsonb), 'by_payer', coalesce(py.by_payer, '{}'::jsonb),
         'by_cpi', coalesce(cp.by_cpi, '{}'::jsonb))
  from t
  join r using (b)
  left join f using (b)
  left join k using (b)
  left join au using (b)
  left join ap using (b)
  left join py using (b)
  left join cp using (b)
$$;

-- ============================================================================================== recompute (pure)
-- daily, actor_days and the wallet facts of (program, gen, days) become pure functions of the events of those
-- days (plus facts sealed on other days). Replays, overlapping or out-of-order batches and reparses therefore
-- leave them byte-identical (spec §4.4, fixes T3).
create or replace function lk.recompute_days(p integer, g integer, d date[]) returns void
language plpgsql as $$
declare
  v_days date[];
  v_cb   date;
begin
  select array_agg(distinct x order by x) into v_days from unnest(d) as x where x is not null;
  if v_days is null then return; end if;
  if exists (select 1 from lk.daily where program_key = p and gen = g and day = any(v_days) and sealed) then
    raise exception 'lk: refusing to rewrite a sealed day (program %, gen %, days %)', p, g, v_days;
  end if;
  select compacted_before into v_cb from lk.builds where program_key = p and gen = g;
  if v_cb is not null and v_days[1] < v_cb then
    raise exception 'lk: refusing to rewrite a compacted day (program %, gen %, day %, compacted before %)',
      p, g, v_days[1], v_cb;
  end if;

  delete from lk.daily where program_key = p and gen = g and day = any(v_days);
  delete from lk.actor_days where program_key = p and gen = g and day = any(v_days);

  insert into lk.actor_days (program_key, gen, day, role, actor)
  select distinct p, g, lk.utc_day(e.block_time), x.role, x.actor
    from lk.events e
   cross join lateral (values
          ('w', case when e.kind in (0, 1, 2, 3, 4, 5, 6, 7, 9, 17) then e.wallet end),
          ('p', case when e.kind in (0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 17, 18) then e.payer end),
          ('a', e.app)) as x(role, actor)
   where e.program_key = p and e.gen = g and e.ok
     and e.block_time >= lk.day_start(v_days[1])
     and e.block_time < lk.day_start(v_days[cardinality(v_days)] + 1)
     and lk.utc_day(e.block_time) = any(v_days)
     and x.actor is not null;

  insert into lk.daily
  select x.*
    from unnest(v_days) as dd
   cross join lateral lk.rollup(p, g, lk.day_start(dd), lk.day_start(dd + 1), 'day') as r
   cross join lateral jsonb_populate_record(null::lk.daily,
            r.m || jsonb_build_object('program_key', p, 'gen', g, 'day', dd, 'sealed', false,
                                      'computed_at', now())) as x;

  -- wallet facts
  update lk.wallets set vault = null, created_at = null, created_sig = null, owner_auth = null, rp_id = null
   where program_key = p and gen = g and lk.utc_day(created_at) = any(v_days);
  update lk.wallets set migrated_at = null, migrated_sig = null, migrated_to_vault = null, migrated_lamports = null
   where program_key = p and gen = g and lk.utc_day(migrated_at) = any(v_days);

  insert into lk.wallets as w (program_key, gen, wallet, vault, created_at, created_sig, owner_auth, rp_id)
  select distinct on (e.wallet) p, g, e.wallet, e.ref, e.block_time, e.signature, e.auth, e.app
    from lk.events e
   where e.program_key = p and e.gen = g and e.ok and e.kind = 0 and e.wallet is not null
     and lk.utc_day(e.block_time) = any(v_days)
   order by e.wallet, e.block_time, e.signature, e.ix_seq
  on conflict (program_key, gen, wallet) do update
     set vault = excluded.vault, created_at = excluded.created_at, created_sig = excluded.created_sig,
         owner_auth = excluded.owner_auth, rp_id = excluded.rp_id
   where w.created_at is null
      or (excluded.created_at, excluded.created_sig) < (w.created_at, w.created_sig);

  insert into lk.wallets as w (program_key, gen, wallet, migrated_at, migrated_sig, migrated_to_vault, migrated_lamports)
  select distinct on (e.wallet) p, g, e.wallet, e.block_time, e.signature, e.ref, e.amount_lamports
    from lk.events e
   where e.program_key = p and e.gen = g and e.ok and e.kind = 17 and e.wallet is not null
     and lk.utc_day(e.block_time) = any(v_days)
   order by e.wallet, e.block_time desc, e.signature desc, e.ix_seq desc
  on conflict (program_key, gen, wallet) do update
     set migrated_at = excluded.migrated_at, migrated_sig = excluded.migrated_sig,
         migrated_to_vault = excluded.migrated_to_vault, migrated_lamports = excluded.migrated_lamports
   where w.migrated_at is null
      or (excluded.migrated_at, excluded.migrated_sig) > (w.migrated_at, w.migrated_sig);

  delete from lk.wallets where program_key = p and gen = g and created_at is null and migrated_at is null;
end $$;

create or replace function lk.complete_through(p integer, g integer) returns timestamptz
language sql stable as $$
  select coalesce((select min(x.block_time) from lk.pending x where x.program_key = p and x.gen = g),
                  (select b.discovered_at from lk.builds b where b.program_key = p and b.gen = g))
$$;

create or replace function lk.maybe_complete_backfill(p integer, g integer) returns void
language sql as $$
  update lk.builds b
     set backfill_complete     = true,
         backfill_completed_at = coalesce(b.backfill_completed_at, now()),
         history_proof         = case when b.history_start_signature is not null then 'deploy_tx' else 'archival_end' end
   where b.program_key = p and b.gen = g and b.history_end_reached
     and not exists (select 1 from lk.pending x where x.program_key = p and x.gen = g)
     and (not b.backfill_complete
          or b.history_proof is distinct from
             case when b.history_start_signature is not null then 'deploy_tx' else 'archival_end' end)
$$;

-- Days before the horizon may be sealed and their events deleted. NULLs are coalesced explicitly: min() and
-- least() ignore NULL, which was the T1 root cause. An unfinished backfill, pending signatures, open gaps (for
-- 30 days) or an old discovery each hold the horizon back (spec §9.1).
create or replace function lk.horizon(p integer, g integer, retention integer) returns date
language sql stable as $$
  select least(
           (now() at time zone 'utc')::date - retention,
           case when b.backfill_complete then 'infinity'::date else '-infinity'::date end,
           coalesce((select lk.utc_day(min(x.block_time)) from lk.pending x
                      where x.program_key = p and x.gen = g), 'infinity'::date),
           coalesce((select lk.utc_day(min(x.block_time)) from lk.gaps x
                      where x.program_key = p and x.gen = g and x.resolved_at is null
                        and x.first_seen_at > now() - interval '30 days'), 'infinity'::date),
           coalesce(lk.utc_day(b.discovered_at), '-infinity'::date))
    from lk.builds b
   where b.program_key = p and b.gen = g
$$;

-- ============================================================================================== invariants (§8.4)
create or replace function lk.check_invariants(p integer) returns jsonb
language plpgsql stable as $$
declare
  v_prog  lk.programs;
  v_b     lk.builds;
  v_s     lk.state_current;
  v_ready boolean;
  v_mode  text;
  v_note  text;
  v_slot  bigint;
  d       record;
  t       record;
  res     jsonb := '[]'::jsonb;
  st      jsonb;
  hk      jsonb;
  hc      numeric; hm numeric; hf numeric; hfund numeric; hw numeric;
  shards  numeric;
begin
  select * into v_prog from lk.programs where program_key = p;
  if not found or v_prog.deploy_status <> 'live' then return '[]'::jsonb; end if;
  select * into v_b from lk.builds where program_key = p and gen = v_prog.active_gen;
  select * into v_s from lk.state_current where program_key = p;
  v_ready := coalesce(v_b.backfill_complete, false)
             and not exists (select 1 from lk.pending x where x.program_key = p and x.gen = v_b.gen)
             and v_s.program_key is not null
             and v_b.discovered_at is not null and v_b.discovered_at >= v_s.fetched_at;
  v_mode := case when v_ready then v_prog.checks_mode else 'pending' end;
  v_note := case
              when v_ready then null
              when not coalesce(v_b.backfill_complete, false) then 'backfill not complete'
              when v_s.program_key is null then 'no state snapshot yet'
              when exists (select 1 from lk.pending x where x.program_key = p and x.gen = v_b.gen) then 'signatures pending'
              else 'discovery older than the state snapshot' end;
  v_slot := coalesce(v_s.slot, 9223372036854775807);
  st := coalesce(v_s.totals, '{}'::jsonb);

  -- H(x) = sum over every daily row - contribution of events with slot > S
  select coalesce(sum(wallets_created), 0) as created, coalesce(sum(migrations), 0) as migr,
         coalesce(sum(fee_lamports), 0) as fee, coalesce(sum(shard_funding_lamports), 0) as fund,
         coalesce(sum(withdrawn_lamports), 0) as withdrawn,
         lk.map_sum_nested(array_agg(by_kind)) as by_kind
    into d
    from lk.daily where program_key = p and gen = v_b.gen;
  select count(*) filter (where ok and kind = 0) as created,
         count(*) filter (where ok and kind = 17) as migr,
         coalesce(sum(fee_lamports) filter (where ok and kind in (0, 4, 7)), 0) as fee,
         coalesce(sum(amount_lamports) filter (where ok and kind = 14), 0) as fund,
         coalesce(sum(amount_lamports) filter (where ok and kind = 13), 0) as withdrawn,
         coalesce((select jsonb_object_agg(kind::text, jsonb_build_object('ok', n))
                     from (select kind, count(*) as n from lk.events
                            where program_key = p and gen = v_b.gen and slot > v_slot and ok and kind <= 18
                            group by kind) z), '{}'::jsonb) as by_kind
    into t
    from lk.events where program_key = p and gen = v_b.gen and slot > v_slot;

  hk := lk.jsonb_add(d.by_kind, lk.jsonb_scale(t.by_kind, -1));
  hc := d.created - t.created;
  hm := d.migr - t.migr;
  hf := d.fee - t.fee;
  hfund := d.fund - t.fund;
  hw := d.withdrawn - t.withdrawn;

  res := res || jsonb_build_object('id', 'I1', 'label', 'wallets created − migrated = wallet accounts',
           'expected', st ->> 'wallets', 'actual', (hc - hm)::text,
           'ok', case when v_ready then (st ->> 'wallets')::numeric = hc - hm end, 'mode', v_mode, 'note', v_note);
  if v_prog.version = 2 then
    res := res || jsonb_build_object('id', 'I2', 'label', 'protocol fees = Σ FeeRecord.total_fees_paid',
             'expected', st #>> '{feeRecords,totalFeesPaid}', 'actual', hf::text,
             'ok', case when v_ready then (st #>> '{feeRecords,totalFeesPaid}')::numeric = hf end,
             'mode', v_mode, 'note', v_note);
  end if;
  shards := coalesce((st #>> '{treasury,shards}')::numeric, 0);
  if shards > 0 or hfund > 0 then
    res := res || jsonb_build_object('id', 'I3', 'label', 'shard lamports = funding + fees − withdrawn',
             'expected', st #>> '{treasury,lamports}', 'actual', (hfund + hf - hw)::text,
             'ok', case when v_ready then (st #>> '{treasury,lamports}')::numeric = hfund + hf - hw end,
             'mode', v_mode, 'note', v_note);
  end if;
  res := res || jsonb_build_object('id', 'I4', 'label', 'sessions created − revoked − closed = session accounts',
           'expected', st #>> '{sessions,total}',
           'actual', (coalesce((hk #>> '{5,ok}')::numeric, 0) - coalesce((hk #>> '{9,ok}')::numeric, 0)
                      - coalesce((hk #>> '{18,ok}')::numeric, 0))::text,
           'ok', case when v_ready then (st #>> '{sessions,total}')::numeric =
                   coalesce((hk #>> '{5,ok}')::numeric, 0) - coalesce((hk #>> '{9,ok}')::numeric, 0)
                   - coalesce((hk #>> '{18,ok}')::numeric, 0) end,
           'mode', v_mode, 'note', v_note);
  res := res || jsonb_build_object('id', 'I5', 'label', 'authorized − executed − reclaimed = deferred accounts',
           'expected', st #>> '{deferred,total}',
           'actual', (coalesce((hk #>> '{6,ok}')::numeric, 0) - coalesce((hk #>> '{7,ok}')::numeric, 0)
                      - coalesce((hk #>> '{8,ok}')::numeric, 0))::text,
           'ok', case when v_ready then (st #>> '{deferred,total}')::numeric =
                   coalesce((hk #>> '{6,ok}')::numeric, 0) - coalesce((hk #>> '{7,ok}')::numeric, 0)
                   - coalesce((hk #>> '{8,ok}')::numeric, 0) end,
           'mode', v_mode, 'note', v_note);
  res := res || jsonb_build_object('id', 'I6', 'label', 'created + added − removed − migrated = authority accounts',
           'expected', st #>> '{authorities,total}',
           'actual', (coalesce((hk #>> '{0,ok}')::numeric, 0) + coalesce((hk #>> '{1,ok}')::numeric, 0)
                      - coalesce((hk #>> '{2,ok}')::numeric, 0) - coalesce((hk #>> '{17,ok}')::numeric, 0))::text,
           'ok', case when v_ready then (st #>> '{authorities,total}')::numeric =
                   coalesce((hk #>> '{0,ok}')::numeric, 0) + coalesce((hk #>> '{1,ok}')::numeric, 0)
                   - coalesce((hk #>> '{2,ok}')::numeric, 0) - coalesce((hk #>> '{17,ok}')::numeric, 0) end,
           'mode', v_mode, 'note', v_note);
  return res;
end $$;

-- ============================================================================================== dashboard pieces

-- {key: n} maps summed key by key (by_auth, by_fail, by_payer, by_cpi)
create or replace function lk.map_sum_flat(maps jsonb[]) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_object_agg(k, s), '{}'::jsonb)
    from (select e.key as k, sum(e.value::numeric) as s
            from unnest(maps) as m(v) cross join lateral jsonb_each_text(coalesce(m.v, '{}'::jsonb)) as e
           group by e.key) z
$$;

-- {key: {a: n, b: n}} maps (by_kind {ok, fail}, by_app {created, ops})
create or replace function lk.map_sum_nested(maps jsonb[]) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_object_agg(okey, inner_obj), '{}'::jsonb)
    from (select okey, jsonb_object_agg(ikey, s) as inner_obj
            from (select o.key as okey, i.key as ikey, sum(i.value::numeric) as s
                    from unnest(maps) as m(v)
                    cross join lateral jsonb_each(coalesce(m.v, '{}'::jsonb)) as o
                    cross join lateral jsonb_each_text(case when jsonb_typeof(o.value) = 'object' then o.value
                                                            else '{}'::jsonb end) as i
                   group by o.key, i.key) x
           group by okey) y
$$;

-- Flow metrics of one program generation over [t0, t1) as a jsonb map keyed like lk.daily columns.
-- from_events: the 24h window (hour precision). Otherwise whole UTC days from lk.daily + lk.actor_days.
create or replace function lk.window_metrics(p integer, g integer, t0 timestamptz, t1 timestamptz, from_events boolean)
returns jsonb language sql stable as $$
  select case when from_events then
           coalesce((select r.m from lk.rollup(p, g, t0, t1, 'none') r), '{}'::jsonb)
         else (
           with d as (
             select * from lk.daily x
              where x.program_key = p and x.gen = g and x.day >= lk.utc_day(t0) and x.day < lk.utc_day(t1)
           )
           select jsonb_build_object(
                    'sigs', coalesce(sum(sigs), 0), 'sigs_failed', coalesce(sum(sigs_failed), 0),
                    'txs', coalesce(sum(txs), 0), 'txs_ok', coalesce(sum(txs_ok), 0),
                    'txs_failed', coalesce(sum(txs_failed), 0), 'noise_txs', coalesce(sum(noise_txs), 0),
                    'unparsed_txs', coalesce(sum(unparsed_txs), 0), 'ixs', coalesce(sum(ixs), 0),
                    'inner_ixs', coalesce(sum(inner_ixs), 0), 'wallets_created', coalesce(sum(wallets_created), 0),
                    'wallets_created_passkey', coalesce(sum(wallets_created_passkey), 0),
                    'executes', coalesce(sum(executes), 0), 'fee_lamports', coalesce(sum(fee_lamports), 0),
                    'fee_events', coalesce(sum(fee_events), 0), 'fee_eligible_ok', coalesce(sum(fee_eligible_ok), 0),
                    'fee_suffix_ok', coalesce(sum(fee_suffix_ok), 0),
                    'shard_funding_lamports', coalesce(sum(shard_funding_lamports), 0))
               || jsonb_build_object(
                    'withdrawn_lamports', coalesce(sum(withdrawn_lamports), 0),
                    'net_fee_lamports', coalesce(sum(net_fee_lamports), 0),
                    'migrations', coalesce(sum(migrations), 0), 'migrated_lamports', coalesce(sum(migrated_lamports), 0),
                    'migrated_tokens', coalesce(sum(migrated_tokens), 0),
                    'cleanup_lamports', coalesce(sum(cleanup_lamports), 0),
                    'retired_calls', coalesce(sum(retired_calls), 0), 'txv1', coalesce(sum(txv1), 0),
                    'shared_txs', coalesce(sum(shared_txs), 0), 'shared_txs_failed', coalesce(sum(shared_txs_failed), 0),
                    'shared_txv1', coalesce(sum(shared_txv1), 0),
                    'by_kind', lk.map_sum_nested(array_agg(by_kind)),
                    'by_auth', lk.map_sum_flat(array_agg(by_auth)),
                    'by_fail', lk.map_sum_flat(array_agg(by_fail)),
                    'shared_by_fail', lk.map_sum_flat(array_agg(shared_by_fail)),
                    'by_app', lk.map_sum_nested(array_agg(by_app)),
                    'by_payer', lk.map_sum_flat(array_agg(by_payer)),
                    'by_cpi', lk.map_sum_flat(array_agg(by_cpi)))
               || jsonb_build_object(
                    'active_wallets', (select count(distinct a.actor) from lk.actor_days a
                                        where a.program_key = p and a.gen = g and a.role = 'w'
                                          and a.day >= lk.utc_day(t0) and a.day < lk.utc_day(t1)),
                    'payers', (select count(distinct a.actor) from lk.actor_days a
                                where a.program_key = p and a.gen = g and a.role = 'p'
                                  and a.day >= lk.utc_day(t0) and a.day < lk.utc_day(t1)),
                    'apps', (select count(distinct a.actor) from lk.actor_days a
                              where a.program_key = p and a.gen = g and a.role = 'a'
                                and a.day >= lk.utc_day(t0) and a.day < lk.utc_day(t1)))
             from d)
         end
$$;

-- Cluster figures: sum over the cluster's programs, then remove the v2 program's shared transactions (a
-- transaction with a real instruction of both programs is in both feeds) so it counts once. Payers and apps
-- are distinct across programs. Active wallets add up (v1 and v2 wallet PDAs are disjoint).
create or replace function lk.cluster_metrics(p_cluster text, t0 timestamptz, t1 timestamptz, from_events boolean)
returns jsonb language plpgsql stable as $$
declare
  m   jsonb;
  v2  jsonb;
  pa  record;
begin
  select lk.jsonb_sum(lk.window_metrics(p.program_key, p.active_gen, t0, t1, from_events))
    into m from lk.programs p where p.cluster = p_cluster;
  select lk.window_metrics(p.program_key, p.active_gen, t0, t1, from_events)
    into v2 from lk.programs p where p.cluster = p_cluster and p.version = 2;
  m := coalesce(m, '{}'::jsonb);
  v2 := coalesce(v2, '{}'::jsonb);
  m := m || jsonb_build_object(
    'sigs',        coalesce((m ->> 'sigs')::numeric, 0) - coalesce((v2 ->> 'shared_txs')::numeric, 0),
    'sigs_failed', coalesce((m ->> 'sigs_failed')::numeric, 0) - coalesce((v2 ->> 'shared_txs_failed')::numeric, 0),
    'txs',         coalesce((m ->> 'txs')::numeric, 0) - coalesce((v2 ->> 'shared_txs')::numeric, 0),
    'txs_failed',  coalesce((m ->> 'txs_failed')::numeric, 0) - coalesce((v2 ->> 'shared_txs_failed')::numeric, 0),
    'txv1',        coalesce((m ->> 'txv1')::numeric, 0) - coalesce((v2 ->> 'shared_txv1')::numeric, 0),
    'by_fail',     lk.jsonb_nonzero(lk.jsonb_add(coalesce(m -> 'by_fail', '{}'::jsonb),
                                                 lk.jsonb_scale(coalesce(v2 -> 'shared_by_fail', '{}'::jsonb), -1))));
  m := m || jsonb_build_object('txs_ok', (m ->> 'txs')::numeric - (m ->> 'txs_failed')::numeric);
  if from_events then
    select count(distinct e.payer) filter (where e.kind in (0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 17, 18)) as payers,
           count(distinct e.app) as apps
      into pa
      from lk.events e join lk.programs p on p.program_key = e.program_key and p.active_gen = e.gen
     where p.cluster = p_cluster and e.ok and e.block_time >= t0 and e.block_time < t1;
  else
    select count(distinct a.actor) filter (where a.role = 'p') as payers,
           count(distinct a.actor) filter (where a.role = 'a') as apps
      into pa
      from lk.actor_days a join lk.programs p on p.program_key = a.program_key and p.active_gen = a.gen
     where p.cluster = p_cluster and a.role in ('p', 'a')
       and a.day >= lk.utc_day(t0) and a.day < lk.utc_day(t1);
  end if;
  return m || jsonb_build_object('payers', coalesce(pa.payers, 0), 'apps', coalesce(pa.apps, 0));
end $$;

create or replace function lk.num(m jsonb, k text) returns numeric
language sql immutable as $$ select coalesce((m ->> k)::numeric, 0) $$;

-- jsonb metric map (lk.daily keys) -> Kpis (src/types/dashboard.ts)
create or replace function lk.kpis_json(m jsonb) returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'signatures', lk.num(m, 'sigs'), 'txs', lk.num(m, 'txs'), 'txsOk', lk.num(m, 'txs_ok'),
    'txsFailed', lk.num(m, 'txs_failed'), 'failByClass', lk.jsonb_nonzero(m -> 'by_fail'),
    'noiseTxs', lk.num(m, 'noise_txs'), 'unparsedTxs', lk.num(m, 'unparsed_txs'), 'ixs', lk.num(m, 'ixs'),
    'walletsCreated', lk.num(m, 'wallets_created'), 'walletsCreatedPasskey', lk.num(m, 'wallets_created_passkey'),
    'activeWallets', lk.num(m, 'active_wallets'), 'payers', lk.num(m, 'payers'), 'apps', lk.num(m, 'apps'),
    'executes', lk.num(m, 'executes'), 'feeLamports', lk.num(m, 'fee_lamports')::text,
    'feeEvents', lk.num(m, 'fee_events'), 'feeEligibleOk', lk.num(m, 'fee_eligible_ok'),
    'feeSuffixOk', lk.num(m, 'fee_suffix_ok'))
  || jsonb_build_object(
    'migrations', lk.num(m, 'migrations'), 'migratedLamports', lk.num(m, 'migrated_lamports')::text,
    'migratedTokenAccounts', lk.num(m, 'migrated_tokens'),
    'shardFundingLamports', lk.num(m, 'shard_funding_lamports')::text,
    'withdrawnLamports', lk.num(m, 'withdrawn_lamports')::text,
    'netFeeLamports', lk.num(m, 'net_fee_lamports')::text,
    'cleanupLamports', lk.num(m, 'cleanup_lamports')::text,
    'retiredCalls', lk.num(m, 'retired_calls'), 'txv1', lk.num(m, 'txv1'))
$$;

-- {key: n} -> [{<name>: key, <value>: n}] top 10 by n
create or replace function lk.top_list(a jsonb, name text, value text) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_agg(jsonb_build_object(name, k, value, n) order by n desc, k), '[]'::jsonb)
    from (select k, (v #>> '{}')::numeric as n
            from jsonb_each(coalesce(a, '{}'::jsonb)) as e(k, v)
           where jsonb_typeof(v) = 'number' and (v #>> '{}')::numeric > 0
           order by 2 desc, 1 limit 10) x
$$;

create or replace function lk.breakdowns_json(m jsonb) returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'byKind', coalesce(m -> 'by_kind', '{}'::jsonb),
    'byAuth', lk.jsonb_nonzero(m -> 'by_auth'),
    'byFail', lk.jsonb_nonzero(m -> 'by_fail'),
    'byApp', (select coalesce(jsonb_agg(jsonb_build_object('app', k, 'created', c, 'ops', o)
                                        order by c + o desc, k), '[]'::jsonb)
                from (select k, coalesce((v ->> 'created')::numeric, 0) as c, coalesce((v ->> 'ops')::numeric, 0) as o
                        from jsonb_each(coalesce(m -> 'by_app', '{}'::jsonb)) as e(k, v)
                       order by 2 + 3 desc, 1 limit 10) x),
    'byPayer', lk.top_list(m -> 'by_payer', 'payer', 'txs'),
    'byCpi', lk.top_list(m -> 'by_cpi', 'program', 'executes'))
$$;

create or replace function lk.dash_programs(p_cluster text) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(x.v order by x.version), '[]'::jsonb)
    from (
      select p.version, jsonb_build_object(
        'programKey', p.program_key, 'cluster', p.cluster, 'version', p.version, 'programId', p.program_id,
        'label', p.label,
        'deployment', jsonb_build_object(
          'status', p.deploy_status,
          'binaryKind', p.binary_kind,
          'binaryLabel', case when kb.sha256 is not null then kb.label
                              when p.binary_sha256 is null then null
                              when coalesce(p.elf_size, 0) < 60000 then 'unrecognised build (sunset-sized)'
                              else 'unrecognised build' end,
          'sha256', p.binary_sha256, 'elfSize', p.elf_size,
          'releaseMatch', case when kb.sha256 is null then null
                               else jsonb_build_object('feature', kb.release_feature, 'source', kb.source) end,
          'lastDeploySlot', p.last_deploy_slot, 'deployedAt', p.deployed_at,
          'upgradeAuthority', p.upgrade_authority,
          'history', (select coalesce(jsonb_agg(jsonb_build_object('slot', d.slot, 'op', d.op, 'at', d.block_time,
                                                  'signature', d.signature, 'sha256', d.sha256)
                                                order by d.slot desc, d.op), '[]'::jsonb)
                        from lk.deploys d where d.program_key = p.program_key)),
        'sync', jsonb_build_object(
          'activeGen', p.active_gen, 'parserVersion', b.parser_version, 'backfillComplete', b.backfill_complete,
          'historyProof', b.history_proof, 'firstActivityAt', b.first_activity_at,
          'completeThrough', lk.complete_through(p.program_key, p.active_gen),
          'discoveredAt', b.discovered_at,
          'pending', (select count(*) from lk.pending x where x.program_key = p.program_key and x.gen = p.active_gen),
          'ingested', b.ingested_sigs,
          'gapsOpen', (select count(*) from lk.gaps x where x.program_key = p.program_key and x.gen = p.active_gen
                         and x.resolved_at is null),
          'lastActivityAt', coalesce(
             (select max(e.block_time) from lk.events e
               where e.program_key = p.program_key and e.gen = p.active_gen and e.kind <= 18),
             (select lk.day_start(max(dd.day)) from lk.daily dd
               where dd.program_key = p.program_key and dd.gen = p.active_gen and dd.txs > 0)),
          'lastRunStatus', p.last_run_status, 'lastError', p.last_error,
          'consecutiveFailures', p.consecutive_failures, 'lastSuccessAt', p.last_success_at,
          'lastRunFinishedAt', p.last_run_finished_at,
          'building', (select jsonb_build_object('gen', bb.gen, 'parserVersion', bb.parser_version,
                                'pending', (select count(*) from lk.pending x
                                             where x.program_key = bb.program_key and x.gen = bb.gen),
                                'ingested', bb.ingested_sigs, 'backfillComplete', bb.backfill_complete)
                         from lk.builds bb where bb.program_key = p.program_key and bb.status = 'building')),
        'state', s.totals, 'stateDetail', s.detail, 'stateSlot', s.slot, 'stateFetchedAt', s.fetched_at,
        'treasury', case when s.totals is null
                           or (coalesce((s.totals #>> '{treasury,shards}')::numeric, 0) = 0 and tr.fund = 0) then null
                         else jsonb_build_object(
                           'fundingLamports', tr.fund::text,
                           'feesLamports', tr.fee::text,
                           'withdrawnLamports', tr.withdrawn::text,
                           'unwithdrawnFeesLamports', (tr.fee - tr.withdrawn)::text,
                           'withdrawableNowLamports', coalesce(s.totals #>> '{treasury,withdrawableNow}', '0'),
                           'excessRentLamports', greatest(0, tr.fund - coalesce((s.totals #>> '{treasury,shards}')::numeric, 0)
                                                              * coalesce((s.totals ->> 'rentMinimum8')::numeric, 0))::text)
                    end,
        'checks', p.checks) as v
        from lk.programs p
        join lk.builds b on b.program_key = p.program_key and b.gen = p.active_gen
        left join lk.known_binaries kb on kb.sha256 = p.binary_sha256
        left join lk.state_current s on s.program_key = p.program_key
        cross join lateral (
          select coalesce(sum(dd.fee_lamports), 0) as fee, coalesce(sum(dd.shard_funding_lamports), 0) as fund,
                 coalesce(sum(dd.withdrawn_lamports), 0) as withdrawn
            from lk.daily dd where dd.program_key = p.program_key and dd.gen = p.active_gen) tr
       where p.cluster = p_cluster
    ) x
$$;

create or replace function lk.dash_latest(p_cluster text) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'programKey', l.program_key, 'version', l.version, 'signature', l.signature, 'blockTime', l.block_time,
           'slot', l.slot, 'kinds', to_jsonb(l.kinds), 'ok', l.ok, 'failClass', l.fail_class, 'errCode', l.err_code,
           'wallet', l.wallet, 'payer', l.payer, 'auth', l.auth, 'feeLamports', l.fee::text, 'app', l.app,
           'txVersion', l.tx_version, 'inner', l.inner_ix) order by l.block_time desc, l.signature), '[]'::jsonb)
    from (
      select e.program_key, p.version, e.signature, min(e.block_time) as block_time, min(e.slot) as slot,
             array_agg(e.kind order by e.ix_seq) filter (where e.kind <= 18) as kinds,
             bool_and(e.ok) as ok, max(e.fail_class) as fail_class, max(e.err_code) as err_code,
             (array_agg(e.wallet order by e.ix_seq) filter (where e.kind <= 18 and e.wallet is not null))[1] as wallet,
             (array_agg(e.payer order by e.ix_seq) filter (where e.kind <= 18 and e.payer is not null))[1] as payer,
             (array_agg(e.auth order by e.ix_seq) filter (where e.kind <= 18 and e.auth is not null))[1] as auth,
             (array_agg(e.app order by e.ix_seq) filter (where e.kind <= 18 and e.app is not null))[1] as app,
             coalesce(sum(e.fee_lamports), 0) as fee, max(e.tx_version) as tx_version,
             bool_or(e.inner_ix) as inner_ix
        from lk.events e
        join lk.programs p on p.program_key = e.program_key and p.active_gen = e.gen
       where p.cluster = p_cluster
       group by e.program_key, p.version, e.signature
      having bool_or(e.kind <= 18)
       order by min(e.block_time) desc, e.signature
       limit 50
    ) l
$$;

create or replace function lk.dash_migration(p_cluster text) returns jsonb
language plpgsql stable as $$
declare
  v1 lk.programs;
  v2 lk.programs;
  s1 jsonb;
  tot record;
  cl record;
  v_from int;
  v_new int;
  v_remaining numeric;
begin
  select * into v1 from lk.programs where cluster = p_cluster and version = 1;
  select * into v2 from lk.programs where cluster = p_cluster and version = 2;
  select totals into s1 from lk.state_current where program_key = v1.program_key;
  select coalesce(sum(migrations), 0) as migrations, coalesce(sum(migrated_lamports), 0) as lamports,
         coalesce(sum(migrated_tokens), 0) as tokens, coalesce(sum(retired_calls), 0) as retired
    into tot from lk.daily where program_key = v1.program_key and gen = v1.active_gen;
  select coalesce(sum(coalesce((by_kind #>> '{8,ok}')::numeric, 0)), 0) as reclaim,
         coalesce(sum(coalesce((by_kind #>> '{18,ok}')::numeric, 0)), 0) as closeexp,
         coalesce(sum(cleanup_lamports), 0) as lamports
    into cl
    from lk.daily d join lk.programs p on p.program_key = d.program_key and p.active_gen = d.gen
   where p.cluster = p_cluster;
  select count(*) filter (where w.vault in (select m.migrated_to_vault from lk.wallets m
                                             where m.program_key = v1.program_key and m.gen = v1.active_gen
                                               and m.migrated_to_vault is not null)),
         count(*)
    into v_from, v_new
    from lk.wallets w where w.program_key = v2.program_key and w.gen = v2.active_gen and w.created_at is not null;
  v_new := v_new - v_from;
  v_remaining := (s1 ->> 'wallets')::numeric;
  return jsonb_build_object(
    'status', case when v1.binary_kind = 'v1-sunset' or tot.migrations > 0 then 'active' else 'not_started' end,
    'v1ProgramKey', v1.program_key, 'v2ProgramKey', v2.program_key, 'v1BinaryKind', v1.binary_kind,
    'totals', jsonb_build_object('migrations', tot.migrations, 'migratedLamports', tot.lamports::text,
                                 'tokenAccounts', tot.tokens),
    'series', (select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'migrations', d.migrations) order by d.day),
                               '[]'::jsonb)
                 from lk.daily d where d.program_key = v1.program_key and d.gen = v1.active_gen and d.migrations > 0),
    'v1WalletsRemaining', v_remaining,
    'v1RemainingVaultLamports', s1 #>> '{vaults,lamports}',
    'percentMigrated', case when v_remaining is null or tot.migrations + v_remaining = 0 then null
                            else round(100.0 * tot.migrations / (tot.migrations + v_remaining), 2) end,
    'v2WalletsFromMigration', coalesce(v_from, 0), 'v2WalletsNew', coalesce(v_new, 0),
    'leftovers', jsonb_build_object('v1Sessions', (s1 #>> '{sessions,total}')::numeric,
                                    'v1Deferred', (s1 #>> '{deferred,total}')::numeric),
    'cleanup', jsonb_build_object('reclaimDeferred', cl.reclaim, 'closeExpiredSession', cl.closeexp,
                                  'lamports', cl.lamports::text),
    'retiredCalls', tot.retired);
end $$;

create or replace function lk.dash_heartbeats() returns jsonb
language sql stable as $$
  select coalesce(jsonb_object_agg(source, jsonb_build_object('at', at, 'detail', detail)), '{}'::jsonb)
    from lk.heartbeats
$$;

-- ============================================================================================== public: readers

create or replace function public.lk_schema_version() returns integer
language sql stable security definer set search_path = lk, pg_temp as $$
  select value::integer from lk.meta where key = 'schema_version'
$$;

create or replace function public.lk_dashboard(p_cluster text, p_window text) returns jsonb
language plpgsql stable security definer set search_path = lk, pg_temp set statement_timeout = '10s' as $$
declare
  v_now      timestamptz := now();
  v_today    date := (now() at time zone 'utc')::date;
  v_events   boolean;
  v_n        integer;
  v_cur      timestamptz;
  v_end      timestamptz;
  v_prev     timestamptz;
  v_first    date;
  v_kpis     jsonb := '{}'::jsonb;
  v_brk      jsonb := '{}'::jsonb;
  v_series   jsonb;
  v_cm       jsonb;
  v_pm       jsonb;
  r          record;
  v2key      integer;
begin
  if p_cluster is null or p_cluster not in ('mainnet', 'devnet') then
    raise exception 'lk: unsupported cluster %', p_cluster using errcode = '22023';
  end if;
  if p_window is null or p_window not in ('24h', '7d', '30d', 'all') then
    raise exception 'lk: unsupported window %', p_window using errcode = '22023';
  end if;
  select program_key into v2key from lk.programs where cluster = p_cluster and version = 2;

  if p_window = '24h' then
    v_events := true;
    v_cur  := date_trunc('hour', v_now at time zone 'utc') at time zone 'utc' - interval '23 hours';
    v_end  := date_trunc('hour', v_now at time zone 'utc') at time zone 'utc' + interval '1 hour';
    v_prev := v_cur - interval '24 hours';
  elsif p_window in ('7d', '30d') then
    v_events := false;
    v_n    := case p_window when '7d' then 7 else 30 end;
    v_cur  := lk.day_start(v_today - (v_n - 1));
    v_end  := lk.day_start(v_today + 1);
    v_prev := lk.day_start(v_today - (2 * v_n - 1));
  else
    v_events := false;
    select min(d.day) into v_first
      from lk.daily d join lk.programs p on p.program_key = d.program_key and p.active_gen = d.gen
     where p.cluster = p_cluster;
    v_cur  := case when v_first is null then null else lk.day_start(v_first) end;
    v_end  := lk.day_start(v_today + 1);
    v_prev := null;
  end if;

  -- KPIs and breakdowns: cluster + each program
  v_cm := lk.cluster_metrics(p_cluster, coalesce(v_cur, '-infinity'::timestamptz), v_end, v_events);
  v_kpis := jsonb_build_object('cluster', jsonb_build_object(
              'current', lk.kpis_json(v_cm),
              'previous', case when v_prev is null then null
                               else lk.kpis_json(lk.cluster_metrics(p_cluster, v_prev, v_cur, v_events)) end));
  v_brk := jsonb_build_object('cluster', lk.breakdowns_json(v_cm));
  for r in select program_key, active_gen from lk.programs where cluster = p_cluster order by version loop
    v_pm := lk.window_metrics(r.program_key, r.active_gen, coalesce(v_cur, '-infinity'::timestamptz), v_end, v_events);
    v_kpis := v_kpis || jsonb_build_object(r.program_key::text, jsonb_build_object(
                'current', lk.kpis_json(v_pm),
                'previous', case when v_prev is null then null
                                 else lk.kpis_json(lk.window_metrics(r.program_key, r.active_gen, v_prev, v_cur, v_events)) end));
    v_brk := v_brk || jsonb_build_object(r.program_key::text, lk.breakdowns_json(v_pm));
  end loop;

  -- series: zero-filled buckets for the cluster scope and every program
  with buckets as (
    select bk from generate_series(v_cur, v_end - case when v_events then interval '1 hour' else interval '1 day' end,
                                   case when v_events then interval '1 hour' else interval '1 day' end) as bk
     where v_cur is not null
  ), progs as (
    select program_key, active_gen from lk.programs where cluster = p_cluster
  ), rows_ as (
    select pr.program_key, x.bucket, x.m
      from progs pr
     cross join lateral (
       select r2.bucket, r2.m from lk.rollup(pr.program_key, pr.active_gen, v_cur, v_end, 'hour') r2 where v_events
       union all
       select lk.day_start(d.day), to_jsonb(d) from lk.daily d
        where not v_events and d.program_key = pr.program_key and d.gen = pr.active_gen
          and d.day >= lk.utc_day(v_cur) and d.day < lk.utc_day(v_end)) x
  ), pts as (
    select pr.program_key, b.bk, coalesce(rw.m, '{}'::jsonb) as m
      from progs pr cross join buckets b
      left join rows_ rw on rw.program_key = pr.program_key and rw.bucket = b.bk
  ), cl as (
    select bk,
           sum(lk.num(m, 'txs')) as txs_all,
           sum(lk.num(m, 'txs_failed')) as tf_all,
           coalesce(sum(lk.num(m, 'shared_txs')) filter (where program_key = v2key), 0) as sh,
           coalesce(sum(lk.num(m, 'shared_txs_failed')) filter (where program_key = v2key), 0) as shf,
           sum(lk.num(m, 'wallets_created')) as wc, sum(lk.num(m, 'active_wallets')) as aw,
           sum(lk.num(m, 'executes')) as ex, sum(lk.num(m, 'fee_lamports')) as fee,
           sum(lk.num(m, 'fee_events')) as fe, sum(lk.num(m, 'migrations')) as mg
      from pts group by bk
  ), out_ as (
    select 0 as ord, bk, jsonb_build_object('scope', 'cluster',
             'bucket', case when v_events then to_char(bk at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
                            else to_char(bk at time zone 'utc', 'YYYY-MM-DD') end,
             'txs', txs_all - sh, 'txsFailed', tf_all - shf, 'walletsCreated', wc, 'activeWallets', aw,
             'executes', ex, 'feeLamports', fee::text, 'feeEvents', fe, 'migrations', mg) as v
      from cl
    union all
    select program_key, bk, jsonb_build_object('scope', program_key::text,
             'bucket', case when v_events then to_char(bk at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
                            else to_char(bk at time zone 'utc', 'YYYY-MM-DD') end,
             'txs', lk.num(m, 'txs'), 'txsFailed', lk.num(m, 'txs_failed'),
             'walletsCreated', lk.num(m, 'wallets_created'), 'activeWallets', lk.num(m, 'active_wallets'),
             'executes', lk.num(m, 'executes'), 'feeLamports', lk.num(m, 'fee_lamports')::text,
             'feeEvents', lk.num(m, 'fee_events'), 'migrations', lk.num(m, 'migrations'))
      from pts
  )
  select coalesce(jsonb_agg(v order by ord, bk), '[]'::jsonb) into v_series from out_;

  return jsonb_build_object(
    'dbSchemaVersion', public.lk_schema_version(),
    'cluster', p_cluster,
    'window', p_window,
    'generatedAt', v_now,
    'range', jsonb_build_object('start', v_cur, 'end', v_now, 'previousStart', v_prev,
                                'bucket', case when v_events then 'hour' else 'day' end),
    'programs', lk.dash_programs(p_cluster),
    'kpis', v_kpis,
    'series', v_series,
    'breakdowns', v_brk,
    'migration', lk.dash_migration(p_cluster),
    'binaries', (select coalesce(jsonb_agg(jsonb_build_object('sha256', k.sha256, 'elfSize', k.elf_size,
                                   'kind', k.kind, 'cluster', k.cluster, 'releaseFeature', k.release_feature,
                                   'label', k.label, 'source', k.source) order by k.kind, k.label), '[]'::jsonb)
                   from lk.known_binaries k where k.cluster = p_cluster or k.cluster is null),
    'latest', lk.dash_latest(p_cluster),
    'runs', (select coalesce(jsonb_agg(jsonb_build_object('runId', x.run_id, 'startedAt', x.started_at,
                               'finishedAt', x.finished_at, 'status', x.status) order by x.started_at desc), '[]'::jsonb)
               from (select * from lk.runs order by started_at desc limit 20) x),
    'heartbeats', lk.dash_heartbeats());
end $$;

create or replace function public.lk_health() returns jsonb
language sql stable security definer set search_path = lk, pg_temp set statement_timeout = '10s' as $$
  select jsonb_build_object(
    'schemaVersion', public.lk_schema_version(),
    'generatedAt', now(),
    'programs', (select coalesce(jsonb_agg(jsonb_build_object(
                   'programKey', p.program_key, 'cluster', p.cluster, 'version', p.version, 'label', p.label,
                   'programId', p.program_id, 'deployStatus', p.deploy_status, 'binaryKind', p.binary_kind,
                   'lastRunStatus', p.last_run_status, 'lastError', p.last_error,
                   'consecutiveFailures', p.consecutive_failures, 'lastSuccessAt', p.last_success_at,
                   'lastRunFinishedAt', p.last_run_finished_at, 'activeGen', p.active_gen,
                   'backfillComplete', b.backfill_complete,
                   'pending', (select count(*) from lk.pending x where x.program_key = p.program_key and x.gen = p.active_gen),
                   'gapsOpen', (select count(*) from lk.gaps x where x.program_key = p.program_key
                                   and x.gen = p.active_gen and x.resolved_at is null),
                   'ingested', b.ingested_sigs,
                   'completeThrough', lk.complete_through(p.program_key, p.active_gen),
                   'discoveredAt', b.discovered_at,
                   'checks', p.checks) order by p.program_key), '[]'::jsonb)
                   from lk.programs p join lk.builds b on b.program_key = p.program_key and b.gen = p.active_gen),
    'heartbeats', lk.dash_heartbeats())
$$;

-- ============================================================================================== public: writers

create or replace function public.lk_worker_context() returns jsonb
language sql stable security definer set search_path = lk, pg_temp set statement_timeout = '60s' as $$
  select jsonb_build_object(
    'schemaVersion', public.lk_schema_version(),
    'now', now(),
    'programs', (select coalesce(jsonb_agg(jsonb_build_object(
        'programKey', p.program_key, 'cluster', p.cluster, 'version', p.version, 'programId', p.program_id,
        'label', p.label, 'checksMode', p.checks_mode, 'deployStatus', p.deploy_status,
        'programdataAddress', p.programdata_address, 'lastDeploySlot', p.last_deploy_slot,
        'binarySha256', p.binary_sha256, 'binaryKind', p.binary_kind, 'activeGen', p.active_gen,
        'lastRunStatus', p.last_run_status, 'consecutiveFailures', p.consecutive_failures,
        'noProgressRuns', p.no_progress_runs,
        'builds', (select coalesce(jsonb_agg(jsonb_build_object(
                     'gen', b.gen, 'status', b.status, 'parserVersion', b.parser_version,
                     'frontierSlot', b.frontier_slot, 'frontierSignature', b.frontier_signature,
                     'frontierBlockTime', b.frontier_block_time, 'discoveredAt', b.discovered_at,
                     'historyEndReached', b.history_end_reached, 'backfillComplete', b.backfill_complete,
                     'ingested', b.ingested_sigs, 'compactedBefore', b.compacted_before,
                     'pending', (select count(*) from lk.pending x where x.program_key = b.program_key and x.gen = b.gen),
                     'gaps', (select count(*) from lk.gaps x where x.program_key = b.program_key and x.gen = b.gen
                                and x.resolved_at is null)) order by b.gen), '[]'::jsonb)
                     from lk.builds b where b.program_key = p.program_key and b.status in ('active', 'building')))
        order by p.program_key), '[]'::jsonb) from lk.programs p),
    'knownBinaries', (select coalesce(jsonb_agg(jsonb_build_object('sha256', k.sha256, 'elfSize', k.elf_size,
                        'kind', k.kind, 'label', k.label) order by k.sha256), '[]'::jsonb) from lk.known_binaries k))
$$;

create or replace function public.lk_set_deployment(p_program integer, p_dep jsonb) returns jsonb
language plpgsql security definer set search_path = lk, pg_temp set statement_timeout = '60s' as $$
declare
  v_prog   lk.programs;
  v_status text := p_dep ->> 'status';
  v_slot   bigint := (p_dep ->> 'deploy_slot')::bigint;
  v_new    boolean;
begin
  select * into v_prog from lk.programs where program_key = p_program for update;
  if not found then raise exception 'lk: unknown program %', p_program; end if;
  if v_status is null or v_status not in ('live', 'not_deployed', 'closed') then
    raise exception 'lk: invalid deployment status %', v_status;
  end if;
  if v_status = 'not_deployed' and v_prog.deploy_status in ('live', 'closed') then v_status := 'closed'; end if;
  v_new := v_slot is not null and v_slot is distinct from v_prog.last_deploy_slot;
  update lk.programs
     set deploy_status       = v_status,
         programdata_address = coalesce(p_dep ->> 'programdata', programdata_address),
         last_deploy_slot    = coalesce(v_slot, last_deploy_slot),
         deployed_at         = case when v_new then (p_dep ->> 'deployed_at')::timestamptz
                                    else coalesce((p_dep ->> 'deployed_at')::timestamptz, deployed_at) end,
         upgrade_authority   = case when p_dep ? 'upgrade_authority' then p_dep ->> 'upgrade_authority'
                                    else upgrade_authority end,
         binary_sha256       = case when v_new and not (p_dep ? 'sha256') then null
                                    else coalesce(p_dep ->> 'sha256', binary_sha256) end,
         elf_size            = case when v_new and not (p_dep ? 'elf_size') then null
                                    else coalesce((p_dep ->> 'elf_size')::integer, elf_size) end,
         binary_kind         = case when v_new and not (p_dep ? 'kind') then null
                                    else coalesce(p_dep ->> 'kind', binary_kind) end,
         binary_checked_at   = case when p_dep ? 'sha256' then now() else binary_checked_at end,
         updated_at          = now()
   where program_key = p_program;
  if v_slot is not null and p_dep ? 'sha256' then
    insert into lk.deploys (program_key, slot, op, block_time, upgrade_authority, sha256, elf_size, kind)
    values (p_program, v_slot, 'observed', (p_dep ->> 'deployed_at')::timestamptz, p_dep ->> 'upgrade_authority',
            p_dep ->> 'sha256', (p_dep ->> 'elf_size')::integer, p_dep ->> 'kind')
    on conflict (program_key, slot, op) do update
       set sha256 = excluded.sha256, elf_size = excluded.elf_size, kind = excluded.kind,
           upgrade_authority = excluded.upgrade_authority, block_time = coalesce(excluded.block_time, lk.deploys.block_time);
  end if;
  return jsonb_build_object('programKey', p_program, 'status', v_status, 'newDeploy', v_new);
end $$;

create or replace function public.lk_enqueue(p_program integer, p_gen integer, p_sigs jsonb, p_final jsonb default null)
returns jsonb
language plpgsql security definer set search_path = lk, pg_temp set statement_timeout = '60s' as $$
declare
  v_b      lk.builds;
  v_queued integer := 0;
  v_slot   bigint;
begin
  perform lk.lock(p_program, p_gen);
  select * into v_b from lk.builds where program_key = p_program and gen = p_gen for update;
  if not found then raise exception 'lk: unknown build (program %, gen %)', p_program, p_gen; end if;
  if v_b.status = 'retired' then raise exception 'lk: build (program %, gen %) is retired', p_program, p_gen; end if;

  if exists (select 1 from jsonb_to_recordset(coalesce(p_sigs, '[]'::jsonb))
                            as x(signature text, slot bigint, block_time timestamptz)
              where x.signature is null or x.slot is null or x.block_time is null) then
    raise exception 'lk: queued signatures need signature, slot and block_time';
  end if;

  with s as (
    select distinct on (x.signature) x.signature, x.slot, x.block_time, x.err
      from jsonb_to_recordset(coalesce(p_sigs, '[]'::jsonb))
           as x(signature text, slot bigint, block_time timestamptz, err jsonb)
     order by x.signature
  ), ins as (
    insert into lk.pending (program_key, gen, signature, slot, block_time, err)
    select p_program, p_gen, s.signature, s.slot, s.block_time, s.err
      from s
     where not exists (select 1 from lk.events e
                        where e.program_key = p_program and e.gen = p_gen and e.signature = s.signature)
       and (v_b.compacted_before is null or s.block_time >= lk.day_start(v_b.compacted_before))
    on conflict do nothing
    returning 1
  )
  select count(*) into v_queued from ins;

  if p_final is not null then
    v_slot := (p_final ->> 'frontier_slot')::bigint;
    update lk.builds b
       set frontier_slot       = case when v_slot is not null and (b.frontier_slot is null or v_slot > b.frontier_slot)
                                      then v_slot else b.frontier_slot end,
           frontier_signature  = case when v_slot is not null and (b.frontier_slot is null or v_slot > b.frontier_slot)
                                      then p_final ->> 'frontier_signature' else b.frontier_signature end,
           frontier_block_time = case when v_slot is not null and (b.frontier_slot is null or v_slot > b.frontier_slot)
                                      then (p_final ->> 'frontier_block_time')::timestamptz else b.frontier_block_time end,
           discovered_at       = greatest(b.discovered_at, (p_final ->> 'discovered_at')::timestamptz),
           history_end_reached = b.history_end_reached or coalesce((p_final ->> 'history_end')::boolean, false)
     where b.program_key = p_program and b.gen = p_gen;
  end if;
  perform lk.maybe_complete_backfill(p_program, p_gen);

  return jsonb_build_object(
    'received', jsonb_array_length(coalesce(p_sigs, '[]'::jsonb)),
    'queued', v_queued,
    'pending', (select count(*) from lk.pending x where x.program_key = p_program and x.gen = p_gen));
end $$;

create or replace function public.lk_pending(p_program integer, p_gen integer, p_limit integer, p_run text)
returns jsonb
language sql stable security definer set search_path = lk, pg_temp set statement_timeout = '60s' as $$
  select coalesce(jsonb_agg(jsonb_build_object('signature', x.signature, 'slot', x.slot, 'block_time', x.block_time,
                                               'err', x.err, 'attempts', x.attempts) order by x.slot, x.signature),
                  '[]'::jsonb)
    from (select * from lk.pending
           where program_key = p_program and gen = p_gen and last_attempt_run is distinct from p_run
           order by slot, signature
           limit greatest(coalesce(p_limit, 0), 0)) x
$$;

create or replace function public.lk_ingest(p_program integer, p_gen integer, p_events jsonb, p_signatures text[],
                                            p_replace boolean default false)
returns jsonb
language plpgsql security definer set search_path = lk, pg_temp set statement_timeout = '60s' as $$
declare
  v_b        lk.builds;
  v_inserted integer := 0;
  v_new_sigs integer := 0;
  v_days     date[];
  v_old_days date[];
  v_bad      text;
  v_sigs     text[] := coalesce(p_signatures, '{}'::text[]);
begin
  perform lk.lock(p_program, p_gen);
  select * into v_b from lk.builds where program_key = p_program and gen = p_gen for update;
  if not found then raise exception 'lk: unknown build (program %, gen %)', p_program, p_gen; end if;
  if v_b.status = 'retired' then raise exception 'lk: build (program %, gen %) is retired', p_program, p_gen; end if;

  -- jsonb_populate_recordset ignores column defaults, so the defaults are filled explicitly here
  drop table if exists pg_temp._lk_in;
  create temp table _lk_in on commit drop as
  select p_program::smallint as program_key, p_gen::smallint as gen, x.signature, x.ix_seq::smallint as ix_seq,
         x.slot, x.block_time, x.kind::smallint as kind, x.top_ix::smallint as top_ix,
         coalesce(x.inner_ix, false) as inner_ix, x.ok, x.fail_class, x.err_code, x.wallet, x.payer,
         x.auth::smallint as auth, coalesce(x.fee_lamports, 0) as fee_lamports, x.amount_lamports,
         x.tokens::smallint as tokens, x.ref, x.app, x.cpi, x.tx_version::smallint as tx_version,
         x.net_fee_lamports, coalesce(x.shared, false) as shared, coalesce(x.flags, 0) as flags,
         coalesce(x.parser_version, v_b.parser_version)::smallint as parser_version
    from jsonb_to_recordset(coalesce(p_events, '[]'::jsonb)) as x(
           signature text, ix_seq integer, slot bigint, block_time timestamptz, kind integer, top_ix integer,
           inner_ix boolean, ok boolean, fail_class text, err_code integer, wallet text, payer text, auth integer,
           fee_lamports bigint, amount_lamports bigint, tokens integer, ref text, app text, cpi text[],
           tx_version integer, net_fee_lamports bigint, shared boolean, flags integer, parser_version integer);

  if exists (select 1 from pg_temp._lk_in
              where signature is null or ix_seq is null or slot is null or block_time is null
                 or kind is null or ok is null) then
    raise exception 'lk: event rows need signature, ix_seq, slot, block_time, kind and ok';
  end if;
  select s into v_bad from unnest(v_sigs) as s
   where not exists (select 1 from pg_temp._lk_in i where i.signature = s and i.ix_seq = 0) limit 1;
  if v_bad is not null then raise exception 'lk: signature % has no ix_seq 0 row', v_bad; end if;
  select i.signature into v_bad from pg_temp._lk_in i where not (i.signature = any(v_sigs)) limit 1;
  if v_bad is not null then raise exception 'lk: row for signature % that is not in p_signatures', v_bad; end if;

  select count(distinct i.signature) into v_new_sigs
    from pg_temp._lk_in i
   where not exists (select 1 from lk.events e
                      where e.program_key = p_program and e.gen = p_gen and e.signature = i.signature);

  if p_replace then
    with del as (
      delete from lk.events e
       using (select distinct signature from pg_temp._lk_in) s
       where e.program_key = p_program and e.gen = p_gen and e.signature = s.signature
      returning e.block_time
    )
    select array_agg(distinct lk.utc_day(block_time)) into v_old_days from del;
  end if;

  with ins as (
    insert into lk.events (program_key, gen, signature, ix_seq, slot, block_time, kind, top_ix, inner_ix, ok,
                           fail_class, err_code, wallet, payer, auth, fee_lamports, amount_lamports, tokens, ref,
                           app, cpi, tx_version, net_fee_lamports, shared, flags, parser_version)
    select program_key, gen, signature, ix_seq, slot, block_time, kind, top_ix, inner_ix, ok, fail_class, err_code,
           wallet, payer, auth, fee_lamports, amount_lamports, tokens, ref, app, cpi, tx_version, net_fee_lamports,
           shared, flags, parser_version
      from pg_temp._lk_in
    on conflict do nothing
    returning block_time
  )
  select count(*), array_agg(distinct lk.utc_day(block_time)) into v_inserted, v_days from ins;

  select array_agg(distinct dd order by dd) into v_days
    from unnest(coalesce(v_days, '{}'::date[]) || coalesce(v_old_days, '{}'::date[])) as dd where dd is not null;
  perform lk.recompute_days(p_program, p_gen, v_days);

  delete from lk.pending where program_key = p_program and gen = p_gen and signature = any(v_sigs);
  update lk.gaps set resolved_at = now()
   where program_key = p_program and gen = p_gen and signature = any(v_sigs) and resolved_at is null
     and exists (select 1 from pg_temp._lk_in i where i.signature = lk.gaps.signature and i.kind <> 253);

  update lk.builds b
     set ingested_sigs           = b.ingested_sigs + v_new_sigs,
         first_activity_at       = least(b.first_activity_at,
                                         (select min(i.block_time) from pg_temp._lk_in i where i.kind <= 18)),
         history_start_signature = coalesce(b.history_start_signature,
                                            (select i.signature from pg_temp._lk_in i where (i.flags & 1) <> 0
                                              order by i.slot, i.signature limit 1))
   where b.program_key = p_program and b.gen = p_gen;

  insert into lk.deploys (program_key, slot, op, signature, block_time)
  select distinct on (i.slot, i.ref) p_program, i.slot, i.ref, i.signature, i.block_time
    from pg_temp._lk_in i
   where (i.flags & 2) <> 0 and i.ref in ('deploy', 'upgrade', 'extend')
   order by i.slot, i.ref, i.signature
  on conflict do nothing;

  perform lk.maybe_complete_backfill(p_program, p_gen);

  return jsonb_build_object('received', (select count(*) from pg_temp._lk_in), 'inserted', v_inserted,
                            'newSignatures', v_new_sigs, 'days', coalesce(to_jsonb(v_days), '[]'::jsonb));
end $$;

create or replace function public.lk_mark_attempt(p_program integer, p_gen integer, p_signature text, p_run text,
                                                  p_error text)
returns jsonb
language plpgsql security definer set search_path = lk, pg_temp set statement_timeout = '60s' as $$
declare
  v_p  lk.pending;
  v_pv smallint;
begin
  perform lk.lock(p_program, p_gen);
  update lk.pending
     set attempts = attempts + case when last_attempt_run is distinct from p_run then 1 else 0 end,
         last_attempt_run = p_run,
         last_error = left(p_error, 500)
   where program_key = p_program and gen = p_gen and signature = p_signature
  returning * into v_p;
  if not found then
    update lk.gaps
       set attempts = attempts + 1, last_attempt_at = now(), reason = coalesce(left(p_error, 500), reason)
     where program_key = p_program and gen = p_gen and signature = p_signature and resolved_at is null;
    return jsonb_build_object('signature', p_signature, 'gap', found, 'converted', false);
  end if;
  if v_p.attempts < 5 then
    return jsonb_build_object('signature', p_signature, 'attempts', v_p.attempts, 'converted', false);
  end if;

  -- 5 failed runs: the signature becomes an explicit gap (counted as unparsed, listed in health, retried later)
  select parser_version into v_pv from lk.builds where program_key = p_program and gen = p_gen;
  insert into lk.events (program_key, gen, signature, ix_seq, slot, block_time, kind, ok, fail_class, flags,
                         parser_version)
  values (p_program, p_gen, p_signature, 0, v_p.slot, v_p.block_time, 253, v_p.err is null,
          case when v_p.err is null then null else 'other' end, 64, v_pv)
  on conflict do nothing;
  insert into lk.gaps (program_key, gen, signature, slot, block_time, err, reason, attempts, last_attempt_at)
  values (p_program, p_gen, p_signature, v_p.slot, v_p.block_time, v_p.err, coalesce(left(p_error, 500), 'unknown'),
          v_p.attempts, now())
  on conflict (program_key, gen, signature) do update
     set attempts = excluded.attempts, reason = excluded.reason, last_attempt_at = now(), resolved_at = null;
  delete from lk.pending where program_key = p_program and gen = p_gen and signature = p_signature;
  update lk.builds set ingested_sigs = ingested_sigs + 1 where program_key = p_program and gen = p_gen;
  perform lk.recompute_days(p_program, p_gen, array[lk.utc_day(v_p.block_time)]);
  perform lk.maybe_complete_backfill(p_program, p_gen);
  return jsonb_build_object('signature', p_signature, 'attempts', v_p.attempts, 'converted', true);
end $$;

create or replace function public.lk_open_gaps(p_program integer, p_gen integer, p_limit integer) returns jsonb
language sql stable security definer set search_path = lk, pg_temp set statement_timeout = '60s' as $$
  select coalesce(jsonb_agg(jsonb_build_object('signature', x.signature, 'slot', x.slot, 'block_time', x.block_time,
                                               'err', x.err, 'attempts', x.attempts, 'reason', x.reason)
                            order by x.slot, x.signature), '[]'::jsonb)
    from (select g.* from lk.gaps g
           where g.program_key = p_program and g.gen = p_gen and g.resolved_at is null
             and not exists (select 1 from lk.daily d where d.program_key = g.program_key and d.gen = g.gen
                               and d.day = lk.utc_day(g.block_time) and d.sealed)
           order by g.slot, g.signature
           limit greatest(coalesce(p_limit, 0), 0)) x
$$;

create or replace function public.lk_reparse_candidates(p_program integer, p_gen integer, p_parser_version integer,
                                                        p_limit integer)
returns text[]
language sql stable security definer set search_path = lk, pg_temp set statement_timeout = '60s' as $$
  select coalesce(array_agg(signature order by slot, signature), '{}'::text[])
    from (select e.signature, min(e.slot) as slot
            from lk.events e
           where e.program_key = p_program and e.gen = p_gen and e.kind <> 253
             and e.parser_version < p_parser_version
             and not exists (select 1 from lk.daily d where d.program_key = e.program_key and d.gen = e.gen
                               and d.day = lk.utc_day(e.block_time) and d.sealed)
           group by e.signature
           order by 2, 1
           limit greatest(coalesce(p_limit, 0), 0)) x
$$;

create or replace function public.lk_write_state(p_program integer, p_slot bigint, p_totals jsonb, p_detail jsonb,
                                                 p_fetched_at timestamptz default null)
returns void
language sql security definer set search_path = lk, pg_temp set statement_timeout = '60s' as $$
  insert into lk.state_current (program_key, slot, fetched_at, totals, detail)
  values (p_program, p_slot, coalesce(p_fetched_at, now()), p_totals, coalesce(p_detail, '{}'::jsonb))
  on conflict (program_key) do update
     set slot = excluded.slot, fetched_at = excluded.fetched_at, totals = excluded.totals, detail = excluded.detail;
  insert into lk.state_daily (program_key, day, slot, totals)
  values (p_program, lk.utc_day(coalesce(p_fetched_at, now())), p_slot, p_totals)
  on conflict (program_key, day) do update set slot = excluded.slot, totals = excluded.totals;
$$;

create or replace function public.lk_heartbeat(p_source text, p_detail jsonb default '{}'::jsonb) returns void
language sql security definer set search_path = lk, pg_temp set statement_timeout = '60s' as $$
  insert into lk.heartbeats (source, at, detail) values (p_source, now(), coalesce(p_detail, '{}'::jsonb))
  on conflict (source) do update set at = excluded.at, detail = excluded.detail;
$$;

-- p_run: {run_id, started_at, finished_at, status: ok|lagging|failed|not_deployed, error, progress, ...}
-- 'ok'/'lagging' are re-derived from the queue; pending signatures without progress for 3 runs => 'failed'.
create or replace function public.lk_report_run(p_program integer, p_gen integer, p_run jsonb) returns jsonb
language plpgsql security definer set search_path = lk, pg_temp set statement_timeout = '60s' as $$
declare
  v_prog     lk.programs;
  v_status   text := coalesce(p_run ->> 'status', 'failed');
  v_err      text := p_run ->> 'error';
  v_progress boolean := coalesce((p_run ->> 'progress')::boolean, false);
  v_pending  integer;
  v_npr      integer;
  v_checks   jsonb;
begin
  if v_status not in ('ok', 'lagging', 'failed', 'not_deployed') then
    raise exception 'lk: invalid run status %', v_status;
  end if;
  select * into v_prog from lk.programs where program_key = p_program for update;
  if not found then raise exception 'lk: unknown program %', p_program; end if;
  select count(*) into v_pending from lk.pending where program_key = p_program and gen = p_gen;
  v_npr := 0;
  if v_status in ('ok', 'lagging') then
    v_status := case when v_pending = 0 then 'ok' else 'lagging' end;
    if v_pending > 0 and not v_progress then v_npr := v_prog.no_progress_runs + 1; end if;
    if v_npr >= 3 then
      v_status := 'failed';
      v_err := coalesce(v_err || '; ', '') ||
               format('no progress on %s pending signatures for %s runs', v_pending, v_npr);
    end if;
  elsif v_status = 'failed' then
    v_npr := v_prog.no_progress_runs;
  end if;
  v_checks := case when v_status = 'not_deployed' then '[]'::jsonb
                   else lk.check_invariants(p_program)
                        || coalesce((select jsonb_agg(c) from jsonb_array_elements(v_prog.checks) c where c ->> 'id' = 'R1'),
                                    '[]'::jsonb) end;
  update lk.programs
     set last_run_id          = p_run ->> 'run_id',
         last_run_started_at  = (p_run ->> 'started_at')::timestamptz,
         last_run_finished_at = coalesce((p_run ->> 'finished_at')::timestamptz, now()),
         last_run_status      = v_status,
         last_error           = left(v_err, 2000),
         consecutive_failures = case when v_status = 'failed' then consecutive_failures + 1 else 0 end,
         no_progress_runs     = v_npr,
         last_success_at      = case when v_status in ('ok', 'lagging', 'not_deployed') then now()
                                     else last_success_at end,
         checks               = v_checks,
         checks_at            = now(),
         updated_at           = now()
   where program_key = p_program
  returning * into v_prog;

  insert into lk.runs (run_id, started_at, finished_at, status, summary)
  values (p_run ->> 'run_id', coalesce((p_run ->> 'started_at')::timestamptz, now()),
          (p_run ->> 'finished_at')::timestamptz,
          case when v_status = 'not_deployed' then 'ok' else v_status end,
          jsonb_build_object(p_program::text, p_run || jsonb_build_object('final_status', v_status)))
  on conflict (run_id) do update
     set finished_at = greatest(lk.runs.finished_at, excluded.finished_at),
         status = case when 'failed' in (lk.runs.status, excluded.status) then 'failed'
                       when 'lagging' in (lk.runs.status, excluded.status) then 'lagging' else 'ok' end,
         summary = coalesce(lk.runs.summary, '{}'::jsonb) || excluded.summary;

  perform public.lk_heartbeat('worker', jsonb_build_object('run_id', p_run ->> 'run_id', 'program', p_program,
                                                          'status', v_status));
  return jsonb_build_object('programKey', p_program, 'status', v_status, 'pending', v_pending,
                            'consecutiveFailures', v_prog.consecutive_failures, 'noProgressRuns', v_npr,
                            'checks', v_checks);
end $$;

create or replace function public.lk_compact(p_retention_days integer) returns jsonb
language plpgsql security definer set search_path = lk, pg_temp set statement_timeout = '60s' as $$
declare
  r         record;
  h         date;
  n         integer;
  v_sealed  integer := 0;
  v_deleted integer := 0;
  v_out     jsonb := '[]'::jsonb;
begin
  if p_retention_days is null or p_retention_days < 3 then
    raise exception 'lk: retention must be at least 3 days (24h window and the 24h before it), got %', p_retention_days;
  end if;
  for r in select b.program_key, b.gen from lk.builds b where b.status in ('active', 'building') order by 1, 2 loop
    perform lk.lock(r.program_key, r.gen);
    h := lk.horizon(r.program_key, r.gen, p_retention_days);
    v_out := v_out || jsonb_build_object('programKey', r.program_key, 'gen', r.gen,
                                         'horizon', case when h = '-infinity'::date then null else h end);
    continue when h is null or h = '-infinity'::date;
    update lk.daily set sealed = true
     where program_key = r.program_key and gen = r.gen and not sealed and day < h;
    get diagnostics n = row_count;
    v_sealed := v_sealed + n;
    delete from lk.events where program_key = r.program_key and gen = r.gen and block_time < lk.day_start(h);
    get diagnostics n = row_count;
    v_deleted := v_deleted + n;
    update lk.builds set compacted_before = greatest(coalesce(compacted_before, h), h)
     where program_key = r.program_key and gen = r.gen;
  end loop;
  delete from lk.runs where run_id in (select run_id from lk.runs order by started_at desc offset 1000);
  return jsonb_build_object('sealedDays', v_sealed, 'deletedEvents', v_deleted, 'builds', v_out);
end $$;

-- R1: every unsealed day's stored daily / actor_days / wallet facts equal a fresh recompute from events.
create or replace function public.lk_verify(p_program integer, p_gen integer) returns jsonb
language plpgsql security definer set search_path = lk, pg_temp set statement_timeout = '60s' as $$
declare
  d          date;
  v_checked  integer := 0;
  v_bad      jsonb := '[]'::jsonb;
  stored     jsonb;
  fresh      jsonb;
  n          integer;
  v_result   jsonb;
  v_drop     text[] := array['program_key', 'gen', 'day', 'sealed', 'computed_at'];
begin
  for d in
    select distinct lk.utc_day(e.block_time) from lk.events e where e.program_key = p_program and e.gen = p_gen
    union
    select x.day from lk.daily x where x.program_key = p_program and x.gen = p_gen and not x.sealed
    order by 1
  loop
    v_checked := v_checked + 1;
    select to_jsonb(x) - v_drop into stored from lk.daily x
     where x.program_key = p_program and x.gen = p_gen and x.day = d;
    select to_jsonb(jsonb_populate_record(null::lk.daily, r.m)) - v_drop into fresh
      from lk.rollup(p_program, p_gen, lk.day_start(d), lk.day_start(d + 1), 'day') r;
    if stored is distinct from fresh then
      v_bad := v_bad || jsonb_build_object('day', d, 'what', 'daily');
    end if;
    select count(*) into n from (
      (select role, actor from lk.actor_days a where a.program_key = p_program and a.gen = p_gen and a.day = d
       except
       select x.role, x.actor from lk.events e
        cross join lateral (values
          ('w', case when e.kind in (0, 1, 2, 3, 4, 5, 6, 7, 9, 17) then e.wallet end),
          ('p', case when e.kind in (0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 17, 18) then e.payer end),
          ('a', e.app)) as x(role, actor)
        where e.program_key = p_program and e.gen = p_gen and e.ok and x.actor is not null
          and e.block_time >= lk.day_start(d) and e.block_time < lk.day_start(d + 1))
      union all
      (select x.role, x.actor from lk.events e
        cross join lateral (values
          ('w', case when e.kind in (0, 1, 2, 3, 4, 5, 6, 7, 9, 17) then e.wallet end),
          ('p', case when e.kind in (0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 17, 18) then e.payer end),
          ('a', e.app)) as x(role, actor)
        where e.program_key = p_program and e.gen = p_gen and e.ok and x.actor is not null
          and e.block_time >= lk.day_start(d) and e.block_time < lk.day_start(d + 1)
       except
       select role, actor from lk.actor_days a where a.program_key = p_program and a.gen = p_gen and a.day = d)) z;
    if n > 0 then
      v_bad := v_bad || jsonb_build_object('day', d, 'what', 'actor_days', 'rows', n);
    end if;
    -- wallet facts created on this day: stored rows must equal the earliest ok CreateWallet of the day, except
    -- wallets whose creation is known from an earlier day
    select count(*) into n from (
      with fresh as (
        select distinct on (e.wallet) e.wallet, e.ref as vault, e.signature as sig
          from lk.events e
         where e.program_key = p_program and e.gen = p_gen and e.ok and e.kind = 0 and e.wallet is not null
           and e.block_time >= lk.day_start(d) and e.block_time < lk.day_start(d + 1)
         order by e.wallet, e.block_time, e.signature, e.ix_seq
      ), fresh_new as (
        select f.* from fresh f
         where not exists (select 1 from lk.wallets w where w.program_key = p_program and w.gen = p_gen
                             and w.wallet = f.wallet and w.created_at < lk.day_start(d))
      ), stored as (
        select w.wallet, w.vault, w.created_sig as sig from lk.wallets w
         where w.program_key = p_program and w.gen = p_gen and lk.utc_day(w.created_at) = d
      )
      (select * from stored except select * from fresh_new)
      union all
      (select * from fresh_new except select * from stored)) z;
    if n > 0 then
      v_bad := v_bad || jsonb_build_object('day', d, 'what', 'wallets', 'rows', n);
    end if;
  end loop;
  v_result := jsonb_build_object('programKey', p_program, 'gen', p_gen, 'daysChecked', v_checked,
                                 'mismatches', jsonb_array_length(v_bad), 'details', v_bad);
  update lk.programs p
     set checks = coalesce((select jsonb_agg(c) from jsonb_array_elements(p.checks) c where c ->> 'id' <> 'R1'),
                           '[]'::jsonb)
                  || jsonb_build_array(jsonb_build_object(
                       'id', 'R1', 'label', 'stored rollups = fresh recompute from events (unsealed days)',
                       'expected', '0 mismatches', 'actual', jsonb_array_length(v_bad)::text || ' mismatches in '
                                                              || v_checked || ' days',
                       'ok', jsonb_array_length(v_bad) = 0, 'mode', 'enforce', 'note', null)),
         checks_at = now()
   where p.program_key = p_program and p.active_gen = p_gen;
  return v_result;
end $$;

-- R2 support (npm run verify:chain): per-day signature counts of the active generation, with the queue state, so
-- the chain's own signature list can be compared day by day (sealed days included).
create or replace function public.lk_verify_counts(p_program integer) returns jsonb
language sql stable security definer set search_path = lk, pg_temp set statement_timeout = '60s' as $$
  select jsonb_build_object(
    'programKey', p.program_key, 'gen', p.active_gen, 'deployStatus', p.deploy_status,
    'frontierSlot', b.frontier_slot, 'backfillComplete', b.backfill_complete,
    'pending', (select count(*) from lk.pending x where x.program_key = p.program_key and x.gen = p.active_gen),
    'stateSlot', (select s.slot from lk.state_current s where s.program_key = p.program_key),
    'state', (select s.totals from lk.state_current s where s.program_key = p.program_key),
    'checks', p.checks,
    'days', (select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'sigs', d.sigs, 'sigsFailed', d.sigs_failed)
                                       order by d.day), '[]'::jsonb)
               from lk.daily d where d.program_key = p.program_key and d.gen = p.active_gen))
    from lk.programs p join lk.builds b on b.program_key = p.program_key and b.gen = p.active_gen
   where p.program_key = p_program
$$;

create or replace function public.lk_start_build(p_program integer, p_parser_version integer) returns integer
language plpgsql security definer set search_path = lk, pg_temp set statement_timeout = '60s' as $$
declare v_gen integer;
begin
  perform 1 from lk.programs where program_key = p_program for update;
  if not found then raise exception 'lk: unknown program %', p_program; end if;
  if exists (select 1 from lk.builds where program_key = p_program and status = 'building') then
    raise exception 'lk: program % already has a building generation', p_program;
  end if;
  select coalesce(max(gen), 0) + 1 into v_gen from lk.builds where program_key = p_program;
  insert into lk.builds (program_key, gen, status, parser_version)
  values (p_program, v_gen, 'building', p_parser_version);
  return v_gen;
end $$;

create or replace function public.lk_promote_build(p_program integer, p_gen integer) returns jsonb
language plpgsql security definer set search_path = lk, pg_temp set statement_timeout = '60s' as $$
declare
  v_new lk.builds;
  v_old lk.builds;
begin
  perform 1 from lk.programs where program_key = p_program for update;
  select * into v_new from lk.builds where program_key = p_program and gen = p_gen for update;
  if not found or v_new.status <> 'building' then
    raise exception 'lk: (program %, gen %) is not a building generation', p_program, p_gen;
  end if;
  select * into v_old from lk.builds where program_key = p_program and status = 'active' for update;
  if not v_new.backfill_complete then raise exception 'lk: generation % has not finished its backfill', p_gen; end if;
  if exists (select 1 from lk.pending where program_key = p_program and gen = p_gen) then
    raise exception 'lk: generation % still has pending signatures', p_gen;
  end if;
  if v_old.gen is not null and v_old.discovered_at is not null
     and (v_new.discovered_at is null or v_new.discovered_at < v_old.discovered_at) then
    raise exception 'lk: generation % is behind the active generation (discovered % < %)',
      p_gen, v_new.discovered_at, v_old.discovered_at;
  end if;
  perform lk.lock(p_program, p_gen);
  if v_old.gen is not null then
    perform lk.lock(p_program, v_old.gen);
    update lk.builds set status = 'retired', retired_at = now() where program_key = p_program and gen = v_old.gen;
  end if;
  update lk.builds set status = 'active', promoted_at = now() where program_key = p_program and gen = p_gen;
  update lk.programs set active_gen = p_gen, updated_at = now() where program_key = p_program;
  if v_old.gen is not null then
    delete from lk.events     where program_key = p_program and gen = v_old.gen;
    delete from lk.daily      where program_key = p_program and gen = v_old.gen;
    delete from lk.actor_days where program_key = p_program and gen = v_old.gen;
    delete from lk.wallets    where program_key = p_program and gen = v_old.gen;
    delete from lk.pending    where program_key = p_program and gen = v_old.gen;
    delete from lk.gaps       where program_key = p_program and gen = v_old.gen;
  end if;
  return jsonb_build_object('programKey', p_program, 'promoted', p_gen, 'retired', v_old.gen);
end $$;

-- ============================================================================================== grants
-- Supabase's default privileges grant EXECUTE on new public functions directly to anon and authenticated, so
-- revoking from PUBLIC alone is not enough: every writer is revoked from the API roles explicitly.
revoke all on all functions in schema lk from public;
revoke all on all tables in schema lk from public;

revoke execute on function public.lk_worker_context()                                   from public, anon, authenticated;
revoke execute on function public.lk_set_deployment(integer, jsonb)                     from public, anon, authenticated;
revoke execute on function public.lk_enqueue(integer, integer, jsonb, jsonb)            from public, anon, authenticated;
revoke execute on function public.lk_pending(integer, integer, integer, text)           from public, anon, authenticated;
revoke execute on function public.lk_ingest(integer, integer, jsonb, text[], boolean)   from public, anon, authenticated;
revoke execute on function public.lk_mark_attempt(integer, integer, text, text, text)   from public, anon, authenticated;
revoke execute on function public.lk_open_gaps(integer, integer, integer)               from public, anon, authenticated;
revoke execute on function public.lk_reparse_candidates(integer, integer, integer, integer) from public, anon, authenticated;
revoke execute on function public.lk_write_state(integer, bigint, jsonb, jsonb, timestamptz) from public, anon, authenticated;
revoke execute on function public.lk_heartbeat(text, jsonb)                             from public, anon, authenticated;
revoke execute on function public.lk_report_run(integer, integer, jsonb)                from public, anon, authenticated;
revoke execute on function public.lk_compact(integer)                                   from public, anon, authenticated;
revoke execute on function public.lk_verify(integer, integer)                           from public, anon, authenticated;
revoke execute on function public.lk_verify_counts(integer)                             from public, anon, authenticated;
revoke execute on function public.lk_start_build(integer, integer)                      from public, anon, authenticated;
revoke execute on function public.lk_promote_build(integer, integer)                    from public, anon, authenticated;

grant execute on function public.lk_worker_context()                                    to service_role;
grant execute on function public.lk_set_deployment(integer, jsonb)                      to service_role;
grant execute on function public.lk_enqueue(integer, integer, jsonb, jsonb)             to service_role;
grant execute on function public.lk_pending(integer, integer, integer, text)            to service_role;
grant execute on function public.lk_ingest(integer, integer, jsonb, text[], boolean)    to service_role;
grant execute on function public.lk_mark_attempt(integer, integer, text, text, text)    to service_role;
grant execute on function public.lk_open_gaps(integer, integer, integer)                to service_role;
grant execute on function public.lk_reparse_candidates(integer, integer, integer, integer) to service_role;
grant execute on function public.lk_write_state(integer, bigint, jsonb, jsonb, timestamptz) to service_role;
grant execute on function public.lk_heartbeat(text, jsonb)                              to service_role;
grant execute on function public.lk_report_run(integer, integer, jsonb)                 to service_role;
grant execute on function public.lk_compact(integer)                                    to service_role;
grant execute on function public.lk_verify(integer, integer)                            to service_role;
grant execute on function public.lk_verify_counts(integer)                              to service_role;
grant execute on function public.lk_start_build(integer, integer)                       to service_role;
grant execute on function public.lk_promote_build(integer, integer)                     to service_role;

revoke execute on function public.lk_schema_version()        from public;
revoke execute on function public.lk_dashboard(text, text)   from public;
revoke execute on function public.lk_health()                from public;
grant execute on function public.lk_schema_version()         to anon, authenticated, service_role;
grant execute on function public.lk_dashboard(text, text)    to anon, authenticated, service_role;
grant execute on function public.lk_health()                 to anon, authenticated, service_role;

commit;

notify pgrst, 'reload schema';
