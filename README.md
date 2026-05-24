# LazorKit Protocol Dashboard

Public read-only dashboard for LazorKit protocol usage and fee metrics.

The dashboard reads current on-chain state directly from Solana RPC. It has no
wallet connection, no backend, no indexer, and no admin controls.

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

Open the local Vite URL printed by the dev server.

## Environment

Copy `.env.example` to `.env.local` only for public browser-safe RPC URLs.

```text
VITE_MAINNET_RPC_URL=https://api.mainnet-beta.solana.com
VITE_DEVNET_RPC_URL=https://api.devnet.solana.com
VITE_LOCALNET_RPC_URL=http://127.0.0.1:8899
VITE_DEFAULT_CLUSTER=mainnet
```

Never put private or key-bearing RPC URLs in `VITE_` variables unless the team
accepts that the URL is visible in browser JavaScript. V1 intentionally does
not render the RPC URL in the UI, but Vite environment variables are still
compiled into the client bundle.

## Checks

```bash
npm test
npm run build
```

## RPC Limitations

This v1 app uses browser-side direct RPC. Public RPC endpoints may rate-limit
large `getProgramAccounts` scans. If that becomes a problem, the next version
should add a small backend cache or indexer.

Private or key-bearing RPC URLs cannot be hidden in a frontend-only app. To use
a private RPC key safely, fetch and aggregate stats in a server-side API route
or indexer, then return only dashboard JSON to the browser.
