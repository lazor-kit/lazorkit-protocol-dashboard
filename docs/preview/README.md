# Dashboard screenshots

Taken on 2026-10-01 (UTC) on a local stack: a local Postgres with the migration applied, the real
`api/dev-server.ts` and Vite, and data from a full backfill of the three live programs (3,826 signatures, paged
from the public RPC; transactions read from a cache of earlier read-only fetches; `npm run verify:chain` reports 0
mismatches against the chain). The states were produced on that local database only (heartbeats aged, `lk_dashboard` renamed away, the
database API stopped) and reverted afterwards. Desktop captures are 1440 px wide, phone captures 390 px; these are
compressed copies (JPEG, about 2 MB in total). The live views (`desktop-*`, `mobile-*`) were taken again at
21:35 UTC after the review fixes (integrators ranked by size, latest activity per version, same-span comparisons)
on a fresh backfill of the same chain data; the `state-*` captures only show the banners and were not retaken.

| file | what it shows |
|---|---|
| `desktop-mainnet-30d.jpg` | mainnet, last 30 days, all versions: overview, programs (v2 not deployed yet), charts, program detail, binaries, migration, latest activity |
| `desktop-mainnet-all-details-open.jpg` | mainnet, all history (weekly bins), with deploy history and developer details open (sync, invariant checks, runs, data notes) |
| `desktop-devnet-7d.jpg` | devnet, last 7 days: v1 and v2 side by side, SIMD-0385 share, v2 release match |
| `desktop-devnet-7d-v1.jpg` | devnet with the v1 filter: latest activity lists v1's own newest transactions although v2 dominates recent traffic |
| `desktop-devnet-30d-v2-light.jpg` | devnet, protocol v2 only, light theme |
| `desktop-mainnet-v2-not-deployed.jpg` | mainnet with the v2 filter: "not deployed yet" with the expected build, no zero KPIs |
| `mobile-devnet-24h.jpg` | phone, devnet, last 24 hours (hourly bins) |
| `mobile-mainnet-30d.jpg` | phone, mainnet, last 30 days, full page |
| `mobile-mainnet-30d-light.jpg` | phone, light theme |
| `state-catching-up-desktop.jpg` | blue banner during the first backfill: "Building history for v2 devnet: 48 % (680 of 1,403 transactions)" |
| `state-first-run-desktop.jpg` | right after the migration, before the first indexer run |
| `state-stale-workflow-disabled-desktop.jpg` / `-mobile.jpg` | red banner: worker heartbeat 30 h old and the GitHub workflow `disabled_inactivity`, with the fix |
| `state-setup-required-desktop.jpg` | amber banner when the migration is missing (what the PR preview shows before step 1) |
| `state-unavailable-desktop.jpg` / `-mobile.jpg` | red banner when the database API is down (HTTP 503), over the copy saved in this browser |
