create table if not exists public.indexer_states (
  cluster text primary key check (cluster in ('mainnet', 'devnet')),
  last_run_started_at timestamptz,
  last_run_completed_at timestamptz,
  last_run_status text not null default 'idle' check (last_run_status in ('idle', 'running', 'success', 'partial', 'failed')),
  last_run_error text,
  last_run_warnings_count integer not null default 0,
  newest_indexed_at timestamptz,
  oldest_indexed_at timestamptz,
  backfill_started_at timestamptz,
  backfill_completed_at timestamptz,
  backfill_before_signature text,
  backfill_complete boolean not null default false,
  backfill_days integer not null default 0,
  backfill_updated_at timestamptz,
  last_successful_run_at timestamptz,
  updated_at timestamptz not null default now()
);

insert into public.indexer_states (
  cluster,
  last_run_started_at,
  last_run_completed_at,
  last_run_status,
  last_run_error,
  last_run_warnings_count,
  newest_indexed_at,
  oldest_indexed_at,
  backfill_started_at,
  backfill_completed_at,
  backfill_before_signature,
  backfill_complete,
  backfill_days,
  backfill_updated_at,
  last_successful_run_at
)
select
  cluster,
  nullif(snapshot #>> '{indexer,lastRunStartedAt}', '')::timestamptz,
  nullif(snapshot #>> '{indexer,lastRunCompletedAt}', '')::timestamptz,
  coalesce(nullif(snapshot #>> '{indexer,lastRunStatus}', ''), 'idle'),
  nullif(snapshot #>> '{indexer,lastRunError}', ''),
  coalesce(nullif(snapshot #>> '{indexer,lastRunWarningsCount}', '')::integer, 0),
  nullif(snapshot #>> '{indexer,newestIndexedAt}', '')::timestamptz,
  nullif(snapshot #>> '{indexer,oldestIndexedAt}', '')::timestamptz,
  nullif(snapshot #>> '{indexer,backfillStartedAt}', '')::timestamptz,
  nullif(snapshot #>> '{indexer,backfillCompletedAt}', '')::timestamptz,
  nullif(snapshot #>> '{indexer,backfillBeforeSignature}', ''),
  coalesce((snapshot #>> '{indexer,backfillComplete}')::boolean, false),
  coalesce(nullif(snapshot #>> '{indexer,backfillDays}', '')::integer, 0),
  nullif(snapshot #>> '{indexer,backfillUpdatedAt}', '')::timestamptz,
  nullif(snapshot #>> '{indexer,lastSuccessfulRunAt}', '')::timestamptz
from public.protocol_snapshots
where snapshot ? 'indexer'
on conflict (cluster) do update set
  last_run_started_at = excluded.last_run_started_at,
  last_run_completed_at = excluded.last_run_completed_at,
  last_run_status = excluded.last_run_status,
  last_run_error = excluded.last_run_error,
  last_run_warnings_count = excluded.last_run_warnings_count,
  newest_indexed_at = excluded.newest_indexed_at,
  oldest_indexed_at = excluded.oldest_indexed_at,
  backfill_started_at = excluded.backfill_started_at,
  backfill_completed_at = excluded.backfill_completed_at,
  backfill_before_signature = excluded.backfill_before_signature,
  backfill_complete = excluded.backfill_complete,
  backfill_days = excluded.backfill_days,
  backfill_updated_at = excluded.backfill_updated_at,
  last_successful_run_at = excluded.last_successful_run_at;

drop trigger if exists indexer_states_set_updated_at
  on public.indexer_states;
create trigger indexer_states_set_updated_at
before update on public.indexer_states
for each row execute function public.set_updated_at();

delete from public.protocol_transactions;
delete from public.protocol_snapshots;
