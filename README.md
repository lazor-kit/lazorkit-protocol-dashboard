# LazorKit Protocol Dashboard

Public read-only dashboard for LazorKit protocol usage and fee metrics.

The dashboard serves a static Vite frontend from Vercel. Its Vercel API routes
are intentionally thin: they only read aggregate Supabase tables. A GitHub
Actions worker runs the Solana RPC/indexer work on a schedule, then writes
dashboard-ready metric buckets, current protocol state, and a small latest
activity buffer back to Supabase.

## Metrics

- **Wallet Accounts**: current `WalletAccount` PDA count.
- **Wallets Recorded**: sum of `FeeRecord.wallet_count`.
- **LazorKit Txns**: sum of `FeeRecord.tx_count`, covering `Execute` and
  `ExecuteDeferred`.
- **Fee-Paying Events**: wallets recorded plus LazorKit txns.
- **Lifetime Fees Recorded**: sum of `FeeRecord.total_fees_paid`.
- **Currently Collectible Fees**: treasury shard balances minus rent reserve.
- **Shard Balances Including Rent**: raw shard lamport balances.
- **Total Transactions**: landed transactions containing a fee-eligible
  LazorKit instruction in the selected window.
- **Wallet Accounts**: current on-chain wallet PDA count, used as the primary
  public wallet/user metric.
- **Success Rate**: successful indexed transactions divided by all indexed
  transactions in the selected window.

`Lifetime Fees Recorded` and `Currently Collectible Fees` are intentionally
separate. Treasury shards can be withdrawn, while `FeeRecord.total_fees_paid`
is cumulative.

## FeeRecord Identity

The current `FeeRecord` account layout does not store the fee payer pubkey.
The record PDA is derived from `[b"fee_record", payer]`, but PDA derivation is
not reversible. The dashboard therefore shows the canonical `FeeRecord` PDA,
not the payer address.

Latest activity can show recent fee payers because the worker parses recent
transactions, but the dashboard does not retain full transaction history.

## Program IDs

- Mainnet: `LazorjRFNavitUaBu5m3WaNPjU1maipvSW2rZfAFAKi`
- Devnet: `4h3XoNReAgEcHVxcZ8sw2aufi9MTr7BbvYYjzjWDyDxS`

## Development

The project keeps the Vercel deployment layout, but local development can run
frontend and backend as separate processes.

Install once:

```bash
npm install
```

Terminal 1, backend API:

```bash
npm run dev:api
```

Terminal 2, frontend web app:

```bash
npm run dev:web
```

Open the local Vite URL printed by the dev server. The Vite dev server also
proxies `/api/*` requests to the backend API at `http://127.0.0.1:8787`, so FE
and BE logs stay separate while browser requests still use same-origin `/api`
URLs.

The deploy layout is:

```text
src/        React/Vite frontend
api/        Thin Vercel read APIs and local API dev server
scripts/    GitHub Actions/local worker entrypoints
supabase/   Supabase migrations and local project config
```

## Environment

Use separate local env files for backend and frontend. Do not put RPC,
Supabase, or cron secrets in the web env file.

Backend secrets:

```bash
cp .env.api.example .env.api.local
```

```text
MAINNET_RPC_URL=https://api.mainnet-beta.solana.com
DEVNET_RPC_URL=https://api.devnet.solana.com
LOCALNET_RPC_URL=http://127.0.0.1:8899
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
INDEXER_BACKFILL_DAYS=60
INDEXER_MAX_SIGNATURES_PER_RUN=50
INDEXER_BACKFILL_MAX_PAGES_PER_RUN=1
INDEXER_PARSE_DELAY_MS=200
INDEXER_MAX_RUNTIME_MS=45000
API_PORT=8787
```

Frontend-only local config:

```bash
cp .env.web.example .env.web.local
```

```text
API_DEV_TARGET=http://127.0.0.1:8787
VITE_DEFAULT_CLUSTER=mainnet
```

Use `MAINNET_RPC_URL` and `DEVNET_RPC_URL` only in local backend env files and
GitHub Actions secrets. Do not create `VITE_MAINNET_RPC_URL`; `VITE_` values are
compiled into browser JavaScript.

Run `supabase/schema.sql` or the migrations in the Supabase SQL editor before
enabling the indexer. The dashboard returns an empty setup-safe analytics state
until Supabase variables are configured and aggregate tables are populated.

## Checks

```bash
npm test
npm run build
npm run typecheck:api
```

## Local Analytics Workflow

Reset only local analytics tables and cached analytics snapshots:

```bash
npm run db:reset-analytics
```

Run one indexer pass:

```bash
npm run indexer:mainnet
npm run indexer:devnet
npm run indexer:all
```

When migrating from the old raw transaction table, rebuild aggregate tables
once:

```bash
npm run db:rebuild-aggregates
```

After a reset the dashboard should show a preparing-data state, not confident
zero activity. After the first indexer pass, the UI will show the latest
available activity while coverage grows.

## RPC Limitations

The Vercel API does not call Solana RPC. Protocol stats are refreshed by the
indexer worker and stored in `protocol_state_snapshots`.
Public RPC endpoints may still rate-limit large `getProgramAccounts` scans, so
production indexing should use a dedicated server-side RPC URL.

Private or key-bearing RPC URLs cannot be hidden in a frontend-only app. This
repo keeps RPC URLs out of the browser and out of Vercel Functions. GitHub
Actions holds the RPC secrets and returns only dashboard JSON through Supabase
and the thin Vercel API.

## Indexer Worker

The indexer runs locally or in GitHub Actions:

```bash
npm run indexer:all
```

GitHub Actions runs `.github/workflows/indexer.yml` every 10 minutes and also
supports manual dispatch. The worker writes aggregate rows to
`protocol_metric_buckets`, keeps only the newest 50 rows per cluster in
`latest_protocol_transactions`, and refreshes protocol config/current-state
metrics in `protocol_state_snapshots`.

The worker fetches newest activity first, then walks older signature pages until
the configured `INDEXER_BACKFILL_DAYS` cutoff. Keep
`INDEXER_BACKFILL_MAX_PAGES_PER_RUN` low for public or rate-limited RPCs; the
indexer stores progress in `protocol_snapshots` and continues on the next cron
run. The default `INDEXER_MAX_SIGNATURES_PER_RUN=50` and
`INDEXER_PARSE_DELAY_MS=200` are intentionally conservative for RPC plans around
10 requests per second; raising them can trigger 429s. `INDEXER_MAX_RUNTIME_MS`
keeps each run bounded; if the budget is reached, the run is recorded as partial
and continues on the next pass.

## GitHub Actions Setup

Add these repository secrets in GitHub:

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
MAINNET_RPC_URL
DEVNET_RPC_URL
```

Optional repository variables:

```text
INDEXER_BACKFILL_DAYS=60
INDEXER_MAX_SIGNATURES_PER_RUN=50
INDEXER_BACKFILL_MAX_PAGES_PER_RUN=1
INDEXER_PARSE_DELAY_MS=200
INDEXER_MAX_RUNTIME_MS=45000
```

Run the workflow manually once after adding secrets. Then verify Supabase:

```sql
select cluster, bucket_granularity, count(*) from protocol_metric_buckets group by 1, 2;
select cluster, wallet_account_count, lifetime_fees_lamports from protocol_state_snapshots;
select cluster, count(*) from latest_protocol_transactions group by 1;
```

## Deployment

Deploy as a Vercel project:

- Framework: Vite
- Build command: `npm run build`
- Output directory: `dist`
- Serverless API: `api/protocol-stats.ts`
- Serverless API: `api/dashboard.ts`
- Required production env: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- Optional env: `VITE_DEFAULT_CLUSTER`

Do not configure Vercel cron for this project. `/api/cron/indexer` is disabled
on purpose so Vercel never imports or executes the Solana RPC stack. Do not set
`MAINNET_RPC_URL`, `DEVNET_RPC_URL`, `CRON_SECRET`, or `INDEXER_*` in Vercel
unless a future thin route explicitly needs them.

After deploy:

```bash
curl "https://your-domain/api/dashboard?cluster=mainnet"
curl "https://your-domain/api/protocol-stats?cluster=mainnet"
```

Both endpoints should return JSON without `ERR_MODULE_NOT_FOUND`,
`ERR_REQUIRE_ESM`, or Solana dependency runtime errors in Vercel logs.
