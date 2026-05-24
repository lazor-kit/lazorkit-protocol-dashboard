create table if not exists public.protocol_transactions (
  cluster text not null check (cluster in ('mainnet', 'devnet')),
  signature text not null,
  slot bigint not null,
  block_time timestamptz not null,
  fee_payer text not null,
  wallet_pda text not null,
  method text not null check (method in ('CreateWallet', 'Execute', 'ExecuteDeferred')),
  status text not null check (status in ('success', 'failed')),
  protocol_fee_lamports numeric(20, 0) not null default 0,
  treasury_shard text,
  fee_record text,
  instruction_index integer not null default 0,
  parse_warnings text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (cluster, signature)
);

create index if not exists protocol_transactions_cluster_time_idx
  on public.protocol_transactions (cluster, block_time desc);

create index if not exists protocol_transactions_wallet_time_idx
  on public.protocol_transactions (cluster, wallet_pda, block_time desc);

create table if not exists public.indexer_cursors (
  cluster text primary key check (cluster in ('mainnet', 'devnet')),
  last_seen_signature text,
  last_indexed_slot bigint,
  last_indexed_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.protocol_snapshots (
  cluster text primary key check (cluster in ('mainnet', 'devnet')),
  snapshot jsonb not null,
  fetched_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists protocol_transactions_set_updated_at
  on public.protocol_transactions;
create trigger protocol_transactions_set_updated_at
before update on public.protocol_transactions
for each row execute function public.set_updated_at();

drop trigger if exists indexer_cursors_set_updated_at
  on public.indexer_cursors;
create trigger indexer_cursors_set_updated_at
before update on public.indexer_cursors
for each row execute function public.set_updated_at();

drop trigger if exists protocol_snapshots_set_updated_at
  on public.protocol_snapshots;
create trigger protocol_snapshots_set_updated_at
before update on public.protocol_snapshots
for each row execute function public.set_updated_at();
