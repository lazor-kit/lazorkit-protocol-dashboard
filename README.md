# LazorKit Protocol Dashboard

Public read-only dashboard for LazorKit protocol usage and fee metrics.

The dashboard reads current on-chain state through a server-side cached API.
It has no wallet connection, no admin controls, and no browser-exposed RPC key.

## Metrics

- **Wallet Accounts**: current `WalletAccount` PDA count.
- **Wallets Recorded**: sum of `FeeRecord.wallet_count`.
- **LazorKit Txns**: sum of `FeeRecord.tx_count`, covering `Execute` and
  `ExecuteDeferred`.
- **Fee-Paying Events**: wallets recorded plus LazorKit txns.
- **Lifetime Fees Recorded**: sum of `FeeRecord.total_fees_paid`.
- **Currently Collectible Fees**: treasury shard balances minus rent reserve.
- **Shard Balances Including Rent**: raw shard lamport balances.

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

```bash
npm install
npm run dev
```

Open the local Vite URL printed by the dev server. The Vite dev server also
serves the local `/api/protocol-stats` route, so no second local process is
required.

## Environment

Copy `.env.example` to `.env.local` for local development. RPC variables do
not use the `VITE_` prefix because they are read only by the server-side API.

```text
MAINNET_RPC_URL=https://api.mainnet-beta.solana.com
DEVNET_RPC_URL=https://api.devnet.solana.com
LOCALNET_RPC_URL=http://127.0.0.1:8899
VITE_DEFAULT_CLUSTER=mainnet
```

Use `MAINNET_RPC_URL` for a full Helius or other private RPC URL in Vercel
environment variables. Do not create `VITE_MAINNET_RPC_URL`; `VITE_` values are
compiled into browser JavaScript.

## Checks

```bash
npm test
npm run build
```

## RPC Limitations

The `/api/protocol-stats` route fetches from RPC server-side and caches results
for 30 seconds per cluster. Public RPC endpoints may still rate-limit large
`getProgramAccounts` scans, so production should use a dedicated server-side
RPC URL.

Private or key-bearing RPC URLs cannot be hidden in a frontend-only app. This
repo now keeps RPC URLs in the backend API and returns only dashboard JSON to
the browser.

## Deployment

Deploy as a Vercel project:

- Framework: Vite
- Build command: `npm run build`
- Output directory: `dist`
- Serverless API: `api/protocol-stats.ts`
- Required production env: `MAINNET_RPC_URL`
- Optional env: `DEVNET_RPC_URL`, `LOCALNET_RPC_URL`, `VITE_DEFAULT_CLUSTER`
