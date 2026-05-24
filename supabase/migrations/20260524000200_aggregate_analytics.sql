create table if not exists public.protocol_metric_buckets (
  cluster text not null check (cluster in ('mainnet', 'devnet')),
  bucket_start timestamptz not null,
  bucket_granularity text not null check (bucket_granularity in ('hour', 'day')),
  tx_count integer not null default 0,
  success_count integer not null default 0,
  failed_count integer not null default 0,
  fee_lamports numeric(20, 0) not null default 0,
  create_wallet_count integer not null default 0,
  execute_count integer not null default 0,
  execute_deferred_count integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (cluster, bucket_granularity, bucket_start)
);

create index if not exists protocol_metric_buckets_cluster_time_idx
  on public.protocol_metric_buckets (cluster, bucket_granularity, bucket_start desc);

create table if not exists public.protocol_state_snapshots (
  cluster text primary key check (cluster in ('mainnet', 'devnet')),
  protocol_status text not null check (protocol_status in ('enabled', 'paused', 'not-initialized')),
  wallet_account_count integer not null default 0,
  fee_record_count integer not null default 0,
  wallets_recorded integer not null default 0,
  txns_recorded integer not null default 0,
  fee_paying_events integer not null default 0,
  lifetime_fees_lamports numeric(20, 0) not null default 0,
  collectible_fees_lamports numeric(20, 0) not null default 0,
  shard_balances_lamports numeric(20, 0) not null default 0,
  snapshot_json jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.latest_protocol_transactions (
  cluster text not null check (cluster in ('mainnet', 'devnet')),
  signature text not null,
  slot bigint not null,
  block_time timestamptz not null,
  fee_payer text not null,
  wallet_pda text not null,
  method text not null check (method in ('CreateWallet', 'Execute', 'ExecuteDeferred')),
  status text not null check (status in ('success', 'failed')),
  fee_lamports numeric(20, 0) not null default 0,
  updated_at timestamptz not null default now(),
  primary key (cluster, signature)
);

create index if not exists latest_protocol_transactions_cluster_time_idx
  on public.latest_protocol_transactions (cluster, block_time desc);

drop trigger if exists protocol_metric_buckets_set_updated_at
  on public.protocol_metric_buckets;
create trigger protocol_metric_buckets_set_updated_at
before update on public.protocol_metric_buckets
for each row execute function public.set_updated_at();

drop trigger if exists protocol_state_snapshots_set_updated_at
  on public.protocol_state_snapshots;
create trigger protocol_state_snapshots_set_updated_at
before update on public.protocol_state_snapshots
for each row execute function public.set_updated_at();

drop trigger if exists latest_protocol_transactions_set_updated_at
  on public.latest_protocol_transactions;
create trigger latest_protocol_transactions_set_updated_at
before update on public.latest_protocol_transactions
for each row execute function public.set_updated_at();
