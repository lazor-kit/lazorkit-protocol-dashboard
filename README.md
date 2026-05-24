# LazorKit Protocol Dashboard

Public read-only dashboard for LazorKit protocol usage and fee metrics.

The dashboard reads on-chain state through server-side APIs. A lightweight
indexer stores LazorKit transaction history in Supabase Postgres so the UI can
show traffic, fee, and success-rate trends without exposing RPC keys.

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
- **Unique Wallets**: distinct LazorKit wallet PDAs parsed from those
  transactions.
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

Showing actual payer addresses requires either an indexed transaction history
mapping payers to records, or a future account layout that stores the payer
pubkey directly.

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
api/        Vercel serverless backend and local API dev server
supabase/   Supabase migrations and local project config
```

## Environment

Copy `.env.example` to `.env.local` for local development. RPC variables do
not use the `VITE_` prefix because they are read only by the server-side API.

```text
MAINNET_RPC_URL=https://api.mainnet-beta.solana.com
DEVNET_RPC_URL=https://api.devnet.solana.com
LOCALNET_RPC_URL=http://127.0.0.1:8899
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
CRON_SECRET=
INDEXER_BACKFILL_DAYS=60
INDEXER_MAX_SIGNATURES_PER_RUN=100
API_PORT=8787
API_DEV_TARGET=http://127.0.0.1:8787
VITE_DEFAULT_CLUSTER=mainnet
```

Use `MAINNET_RPC_URL` for a full Helius or other private RPC URL in Vercel
environment variables. Do not create `VITE_MAINNET_RPC_URL`; `VITE_` values are
compiled into browser JavaScript.

Run `supabase/schema.sql` in the Supabase SQL editor before enabling the
indexer. The dashboard returns an empty setup-safe analytics state until
Supabase variables are configured.

## Checks

```bash
npm test
npm run build
npm run typecheck:api
```

## RPC Limitations

The `/api/protocol-stats` route fetches from RPC server-side and caches results
for 30 seconds per cluster. Public RPC endpoints may still rate-limit large
`getProgramAccounts` scans, so production should use a dedicated server-side
RPC URL.

Private or key-bearing RPC URLs cannot be hidden in a frontend-only app. This
repo now keeps RPC URLs in the backend API and returns only dashboard JSON to
the browser.

## Indexer

The indexer endpoint is protected by `CRON_SECRET`:

```bash
curl "https://your-domain/api/cron/indexer?cluster=all&secret=$CRON_SECRET"
```

Vercel Cron runs `/api/cron/indexer?cluster=all` every five minutes. Vercel
sends `Authorization: Bearer $CRON_SECRET` when the env var is configured.
The indexer stores one row per transaction signature and upserts by
`(cluster, signature)`.

## Deployment

Deploy as a Vercel project:

- Framework: Vite
- Build command: `npm run build`
- Output directory: `dist`
- Serverless API: `api/protocol-stats.ts`
- Serverless API: `api/dashboard.ts`
- Cron API: `api/cron/indexer.ts`
- Required production env: `MAINNET_RPC_URL`, `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`
- Optional env: `DEVNET_RPC_URL`, `LOCALNET_RPC_URL`, `VITE_DEFAULT_CLUSTER`,
  `INDEXER_BACKFILL_DAYS`, `INDEXER_MAX_SIGNATURES_PER_RUN`
