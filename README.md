# LazorKit Protocol Dashboard

Public read-only dashboard for LazorKit protocol usage, fees and health, for **protocol v1 and v2** on mainnet
and devnet.

| key | cluster | version | program id | today |
|---|---|---|---|---|
| 1 | mainnet | v1 | `LazorjRFNavitUaBu5m3WaNPjU1maipvSW2rZfAFAKi` | live (full v1); Phase B will upgrade it to the sunset build |
| 2 | mainnet | v2 | `LazorFroiVuAjcwwQ2me83vTr5nc5NRxSaTg3pmEXC8` | not deployed yet; picked up automatically on its first deploy |
| 3 | devnet | v1 | `4h3XoNReAgEcHVxcZ8sw2aufi9MTr7BbvYYjzjWDyDxS` | live, dormant |
| 4 | devnet | v2 | `57bTNWqtYTJbWuLWASKo6GqUTAK6oFDUR5c6hEc6V8nv` | live (release build) |

## Architecture

There is no always-on server. The backend is:

```
GitHub Actions  .github/workflows/indexer.yml  (schedule 7,22,37,52 * * * *, repository_dispatch indexer-tick
  │                                              from an external cron every 15 min, manual dispatch)
  └─ npm run indexer → worker/main.ts            the only regular writer (service-role key)
       mainnet lane ‖ devnet lane; per program: deployment + binary → state snapshot → discovery → ingest
       RPC: MAINNET_RPC_URL / DEVNET_RPC_URL (primary), public endpoints as archival fallback
       DB : POST {SUPABASE_URL}/rest/v1/rpc/lk_*

Vercel  static Vite SPA + read-only functions (never calls Solana RPC, never imports worker/)
  ├─ GET /api/dashboard?cluster=mainnet|devnet&window=24h|7d|30d|all   one RPC: lk_dashboard
  ├─ GET /api/health                                                  200 live/catching_up/delayed, 503 otherwise;
  │                                                                     lastWorkerTrigger = what started the last run
  ├─ GET /api/protocol-stats?cluster=                                 compatibility alias (current state)
  └─ GET /api/cron/heartbeat                                          daily Vercel cron, production + CRON_SECRET only

Supabase (free project)
  schema lk (NOT exposed through the REST API) + public.lk_* SECURITY DEFINER functions
  readers (lk_dashboard, lk_health, lk_schema_version) → anon/authenticated/service_role; writers → service_role
```

```text
src/          React/Vite frontend; src/types/ is the payload contract shared with the API and the worker
api/          thin Vercel functions + local dev server (api/dev-server.ts)
worker/       the indexer: rpc/ chain/ parse/ state/ loop/ db/ verify/ (+ tests and fixtures)
supabase/     migrations (20261002000100_lk_event_log.sql is the v2 backend) and pgTAP tests
it/           integration tests through a local PostgREST
```

### Stores little, never re-fetches everything

- **One cursor per program** (`lk.builds.frontier_slot`). Each run asks `getSignaturesForAddress` only for
  signatures newer than the frontier and fetches only those transactions. A quiet program costs one small call.
- **Durable queue** (`lk.pending`). Discovery stores what it finds, then ingestion drains it oldest first, 20 at a
  time, until the run budget is spent; the next run continues. Nothing is skipped: a transaction that no endpoint
  serves is retried in 5 separate runs and then becomes an explicit, counted **gap** (`lk.gaps`, kind 253). The same
  goes for a transaction whose rows the database rejects (a SQL data error): the batch is retried one signature at
  a time, so one bad transaction never holds back the rest of the queue, and the run summary lists it.
- **Ledger + rollups.** `lk.events` holds one thin row per LazorKit instruction (or one row for a transaction
  without one) and doubles as the de-duplication ledger. Daily rollups (`lk.daily`) and distinct actors per day
  (`lk.actor_days`) are **recomputed** from the events of the touched days, never incremented, so replays,
  overlapping or out-of-order batches and reparses all give identical results.
- **Bounded retention.** Events older than `INDEXER_EVENT_RETENTION_DAYS` (35; at least 31, because the 30-day
  comparison reads the events of the day 30 days ago) are deleted once their days are
  final ("sealed"); daily rollups are kept forever. Expected size: about 15 MB in year one, then about +7 MB a year,
  of the 500 MB free plan.
- **One-time backfill.** A new program (or a rebuild) pages to the program's deploy transaction (proof that the
  history is complete) and works through its queue over as many runs as needed.
- **State** (wallets, authorities, sessions, fee config, treasury, vault SOL) comes from one `getProgramAccounts`
  per program per run, taken before discovery so history and state can be checked against each other (I1–I6).

## Metrics (exact definitions)

"Real" transaction = at least one LazorKit instruction with a known tag (0–18). Counts of transactions are
distinct signatures. Windows are UTC: `24h` = the last 24 hours by hour, the newest one partial (from events),
`7d`/`30d` = whole days incl. today so far, `all` = since the first activity (complete history). The change shown
against the previous period compares the **same elapsed span one period earlier**: the previous period ends exactly
24 h / 7 d / 30 d before now (its last, partial day comes from the events), so a partly elapsed hour or day is never
compared with a whole one.

| metric | rule |
|---|---|
| Signatures | every signature in the program's feed (real + noise + unparsed) |
| Transactions / success | signatures with a real instruction, split by transaction success. Failures are classed: `lazorkit` (3001+/4001+ or a LazorKit error), `duplicate` (AccountAlreadyInitialized, 3006), `cpi` (a called program failed), `limits` (compute / loaded data), `other_ix`, `retired` (4018, Phase B), `noise`, `other` |
| Instructions by type | every LazorKit instruction (top-level and CPI), ok / failed |
| Wallets created | successful CreateWallet; passkey share from the owner type |
| Active wallets | distinct wallets of successful wallet operations (kinds 0–7, 9, 17); exact for any window |
| Executions by signer | Execute/ExecuteDeferred by passkey (precompile at i−1), session or Ed25519 (PDA match), deferred |
| Protocol fees | the first direct-child System transfer of CreateWallet/Execute/ExecuteDeferred from the payer **to a canonical treasury shard** (a vault → payer transfer is not a fee; for a first-time payer v2 first creates the payer's FeeRecord with its own transfer, which is neither a fee nor something the wallet called). Fee events, eligible operations, suffix adoption (v1) |
| Treasury | shard funding (InitializeTreasuryShard), withdrawals (WithdrawTreasury); "unwithdrawn fees" from history vs "withdrawable now" from state (they differ by the excess rent left by the 2026 rent decrease) |
| Integrators | passkey clientDataJSON `topOrigin ?? origin`, CreateWallet rpId (normalised host; Android apps as `android:<hash prefix>`); the top 10 by wallets created + operations |
| Relayers | distinct instruction payers |
| Migrations v1 → v2 | successful MigrateWallet at the v1 id (sunset build): count, SOL, token accounts; v2 wallets created by migration vs new |
| Tx v1 (SIMD-0385) | real transactions with transaction version 1 |
| Cluster totals | sum of the cluster's programs minus the v2 program's "shared" transactions (a transaction with real instructions of both programs is in both feeds); a shared failed transaction keeps the class of the program whose instruction failed; payers and apps distinct across programs |
| State | wallets, authorities by role/type, owner key types, lifetime passkey operations, sessions live/expired, deferred pending/expired and stranded rent, fee config (v1 `enabled=0` means "fees off; wallets unaffected"), FeeRecords (v1: registered payers only, a lower bound; v2: exact), treasury, vault SOL |

## Freshness and keep-alive

The API computes `freshness.state` (first match wins): `setup_required` (migration missing) → `unavailable`
(database unreachable or paused) → `stale` (worker heartbeat older than 12 h, or the daily cron reports the
workflow disabled) → `delayed` (heartbeat 2–12 h old, or 2+ consecutive failures) → `catching_up` (backfill or
backlog) → `live`.

**Why 2 h and 12 h.** The indexer is meant to run every 15 minutes, so a 2 h old heartbeat is about 8 missed runs
and the site should no longer call itself live (`delayed` is an amber banner; `/api/health` still answers 200).
GitHub's `schedule` on its own is best effort: from May to July 2026 it ran this workflow about 10 times a day
instead of the 144 its cron asked for (gaps: median 1.8 h, 90th percentile 4.1 h, largest 6.05 h), and only once
(10:04 UTC) in the 12 hours after the 2026-10-02 merge. With only that trigger the site therefore shows `delayed` between late runs, which
is the truth; the external cron below is what keeps it `live`. `stale` (red banner, `/api/health` 503, the uptime
monitor e-mails) starts at 12 h, about twice the worst gap the schedule alone has produced, so a late schedule does
not wake anyone, while a real outage is reported within half a day.

`/api/health` also reports `lastWorkerTrigger`, the `GITHUB_EVENT_NAME` the worker recorded in its heartbeat:
`schedule`, `repository_dispatch` (the external cron), `workflow_dispatch` (manual), `push` (a merge that touches the
indexer) or `local`; `null` when the last heartbeat did not record one (Developer details shows it too).

| failure | what happens |
|---|---|
| GitHub runs the schedule late or rarely (it is best effort) | the external cron below sends `repository_dispatch` every 15 minutes; the site turns amber after 2 h without a run and red after 12 h |
| GitHub disables the schedule after 60 days without commits | the daily Vercel cron records the workflow state; the site turns red with the fix; `/api/health` returns 503, which the **uptime monitor** (go-live step 4) turns into an email. Re-enable with `gh workflow enable indexer.yml`: nothing is lost, the queue just has a longer backlog |
| Supabase free project pauses after 7 days idle | every worker run writes, and the daily `/api/cron/heartbeat` writes too (independent of GitHub) |
| a program fails while others work | the run exits 1 (red job, GitHub email); per-program status and last error are on the page |
| silent loss or double counting | queue + ledger + pure recompute; invariants I1–I6 and `lk_verify` (R1) every run; `npm run verify:chain` (R2) |

**When to expect it.** GitHub counts 60 days from the repository's last commit; after the merge that is the merge
date + 60 days, and any later commit restarts the count. Check the state with
`gh api repos/lazor-kit/lazorkit-protocol-dashboard/actions/workflows/indexer.yml --jq .state` (`active` is fine).
Nothing on GitHub or Vercel e-mails anyone when it happens, which is why the uptime monitor is part of go-live, not
a follow-up.

**Optional self-enable step (not shipped).** A job could re-enable the workflow itself, but the popular
keepalive action's repository was disabled by GitHub Staff (a Terms-of-Service signal), and whether the enable API
call resets the 60-day timer is unverified. If the maintainers want it anyway, add to `indexer.yml`:

```yaml
  keepalive:
    if: vars.INDEXER_SELF_KEEPALIVE == 'true'
    runs-on: ubuntu-latest
    permissions:
      actions: write
    steps:
      - run: gh api -X PUT repos/${{ github.repository }}/actions/workflows/indexer.yml/enable
        env:
          GH_TOKEN: ${{ github.token }}
```

### Second trigger: an external cron (maintainer, once)

The workflow also runs on `repository_dispatch` events of type `indexer-tick`, which do not depend on GitHub's
scheduler. A free external cron sends one every 15 minutes. GitHub only runs `repository_dispatch` for the workflow
file on the default branch, so it works once `main` has the `repository_dispatch` trigger. The token lives only in
the cron service: it is not a repository secret and nothing in this repository reads it.

1. **Token.** GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate
   new token. Resource owner `lazor-kit` (the organisation may have to approve it); Repository access → *Only select
   repositories* → `lazorkit-protocol-dashboard`; Repository permissions → **Contents: Read and write** (GitHub
   requires write access to Contents for `POST /repos/{owner}/{repo}/dispatches`; Metadata: Read-only is added
   automatically); nothing else. Give it an expiry (for example one year) and a reminder to rotate it. Contents
   write also allows pushing to this repository, so store the token nowhere else.
2. **Cron job**, for example on [cron-job.org](https://cron-job.org) (free): a new cron job with
   - URL `https://api.github.com/repos/lazor-kit/lazorkit-protocol-dashboard/dispatches`
   - schedule every 15 minutes
   - request method `POST`, request body `{"event_type":"indexer-tick"}`
   - headers `Accept: application/vnd.github+json`, `Authorization: Bearer <token>`,
     `X-GitHub-Api-Version: 2022-11-28`, `Content-Type: application/json` (and a `User-Agent` such as
     `lazorkit-dashboard-cron` if the service sends none; GitHub rejects requests without one)
   - failure notifications on. GitHub answers **204 No Content**; 401 means the token expired or was revoked, 403
     or 404 that it lacks Contents write or access to this repository.
3. **Check it once.** Run the cron job once by hand (a "test run", or the same request with `curl`), then
   `gh run list -R lazor-kit/lazorkit-protocol-dashboard --workflow indexer.yml --event repository_dispatch --limit 3`
   should list a run, and after it finishes
   `curl -s https://lazorkit-protocol-dashboard.vercel.app/api/health | jq .lastWorkerTrigger` says
   `"repository_dispatch"` (the API caches for a minute).

Both triggers run the same incremental job (mode `incremental`, 10-minute budget; the dispatch payload is ignored).
The workflow's concurrency group keeps runs from overlapping: one runs, at most one waits, and a newer waiting run
replaces an older one, so a tick that arrives during a run costs nothing (it may show up as a *cancelled* run). A
quiet run takes about 30 seconds and some 30 RPC calls, and Actions minutes are free for this public repository.
The external cron does **not** prevent the 60-day disable above: a disabled workflow runs for no event, even though
the dispatch request still answers 204. The daily heartbeat cron and the uptime monitor still catch that case.

## Go-live (maintainer, in this order)

0. **Today, before anything else: keep Supabase awake.** It was resumed on 2026-10-01 and nothing writes to it until
   the indexer runs again, so it can pause again about a week later (around 2026-10-08) if go-live slips. Enabling
   the workflow is enough: until the merge, the schedule on `main` runs the old indexer, which writes the old tables
   (harmless) and so keeps the project active.

   ```bash
   gh workflow enable indexer.yml -R lazor-kit/lazorkit-protocol-dashboard
   ```

1. **Apply the migration.** Supabase dashboard → SQL Editor → paste
   `supabase/migrations/20261002000100_lk_event_log.sql` → Run. It is additive (schema `lk` + `public.lk_*`
   functions only; the legacy tables are untouched) and re-running it is harmless. Check:
   `select public.lk_schema_version();` → `1`. The PR preview moves from "Backend upgrade pending" to
   "Catching up"; production is unchanged.
2. **Run the first backfill from the PR branch** (the `enable` is a no-op if step 0 was done):

   ```bash
   gh workflow enable indexer.yml -R lazor-kit/lazorkit-protocol-dashboard
   gh workflow run    indexer.yml -R lazor-kit/lazorkit-protocol-dashboard --ref rebuild/v1-v2 \
     -f mode=incremental -f budget_minutes=55
   ```

   On public RPC the backfill takes 30–60 minutes. If the budget runs out, or the run is cancelled because an old
   scheduled run holds the shared concurrency group, run the same command again: it resumes from the queue. Until
   the merge, the schedule on `main` runs the old indexer, which only writes the old tables (harmless). Wait for a
   green run: every program `ok`, invariants `ok`, and the preview showing live figures.
3. **Merge the PR.** The push to `main` runs the new indexer once (incremental); from then on the schedule runs it
   (`7,22,37,52 * * * *`, best effort) together with the external cron (step 5), and the daily heartbeat cron is registered by this deploy (`vercel.json`, uses the
   existing `CRON_SECRET`). `curl -s https://lazorkit-protocol-dashboard.vercel.app/api/health` should say
   `"status":"live"`.
4. **Add an uptime monitor (required: it is the only thing that e-mails someone).** Any free HTTP monitor (for
   example UptimeRobot or Better Stack) on `https://lazorkit-protocol-dashboard.vercel.app/api/health`, every 5–15
   minutes, alerting the maintainers' e-mail on any non-2xx answer. `/api/health` answers 503 when the data is stale
   (worker silent for 12 h, or the daily cron saw GitHub disable the workflow) or the database is unreachable or
   paused, and 200 otherwise. Set it up after step 3; before the migration it would answer 503 by design.
5. **Add the external cron** (required for a live dashboard: without it GitHub's schedule leaves gaps of hours and
   the banner shows *delayed* in between). Token and cron job as described in
   [Second trigger: an external cron](#second-trigger-an-external-cron-maintainer-once).

Merging before step 2 also works: production then shows "Catching up: the indexer has not run yet" until the first
run (`gh workflow enable` + `gh workflow run indexer.yml -f budget_minutes=55`, without `--ref`) has finished.

No new secrets, repository or Vercel settings (steps 4 and 5 are outside services; the step-5 token is a personal
token kept by the cron service, not a repository secret): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `MAINNET_RPC_URL`, `DEVNET_RPC_URL` and
`CRON_SECRET` are reused; the old `INDEXER_*` variables are ignored.

**Rollback.** Revert the merge commit (the old code and the legacy tables are untouched), optionally
`gh workflow disable indexer.yml`, and optionally drop the new objects:

```sql
drop function if exists public.lk_dashboard(text, text), public.lk_health(), public.lk_schema_version(),
  public.lk_worker_context(), public.lk_set_deployment(integer, jsonb), public.lk_enqueue(integer, integer, jsonb, jsonb),
  public.lk_pending(integer, integer, integer, text), public.lk_ingest(integer, integer, jsonb, text[], boolean),
  public.lk_mark_attempt(integer, integer, text, text, text), public.lk_open_gaps(integer, integer, integer),
  public.lk_reparse_candidates(integer, integer, integer, integer),
  public.lk_write_state(integer, bigint, jsonb, jsonb, timestamptz), public.lk_heartbeat(text, jsonb),
  public.lk_report_run(integer, integer, jsonb), public.lk_compact(integer), public.lk_verify(integer, integer),
  public.lk_verify_counts(integer), public.lk_start_build(integer, integer), public.lk_promote_build(integer, integer);
drop schema if exists lk cascade;
```

## Operating the indexer

| dispatch input `mode` | effect |
|---|---|
| `incremental` (schedule, external cron) | discover new signatures, ingest the queue, snapshot state, retry gaps, compact, verify |
| `reparse` | after a parser fix (bump `PARSER_VERSION` in `worker/chain/constants.ts`): re-fetch and replace rows parsed by an older version, on days still within the retention window |
| `rebuild` + `program` | a parser fix that must reach sealed history, or a new metric: a new generation backfills beside the live one and is promoted atomically when caught up; the site keeps serving the old one meanwhile |
| `verify` | `lk_verify` for every live program plus the chain recomputation (`npm run verify:chain`) |

Exit codes: `0` ok (or lagging with progress, or not deployed), `1` a program failed / made no progress for 3 runs /
`lk_verify` mismatch, `2` the migration is missing.

**v2 mainnet** needs no step: the first run after its deploy sees the program account, identifies the binary
against `scripts/release-hashes.txt` (lazorkit-protocol) and backfills it. **Phase B** shows up as v1's binary
kind changing to `v1-sunset`, and the migration panel starts counting MigrateWallet.

**Adding a program** (e.g. the foundation devnet program): one `insert into lk.programs` and one
`insert into lk.builds (program_key, gen, status, parser_version) values (<key>, 1, 'active', 1)`, plus an entry in
`src/types/protocol.ts`.

## Dashboard UI

One page, driven by the URL: `?cluster=mainnet|devnet&window=24h|7d|30d|all&version=all|1|2` (shareable; the
default cluster comes from `VITE_DEFAULT_CLUSTER`). It makes one request, `GET /api/dashboard`, typed by
`src/types/dashboard.ts`, and never talks to Solana RPC itself. Top to bottom:

| section | what it shows |
|---|---|
| Header | cluster, protocol version (All / v1 / v2) and time range; "data complete through" and "indexer checked … ago" (the request time is never shown as "last updated"); a status pill; theme toggle |
| Freshness banner | blue *catching up* (backfill %, backlog), amber *delayed* (last run 2–12 h ago, or a program failing) or *setup required*, red *stale* (no run for 12 h, or with `gh workflow enable indexer.yml` when GitHub disabled the schedule) or *unavailable* (over the copy saved in this browser) |
| Overview | transactions (success and protocol error rate), active wallets, wallets created (passkey share), protocol fees, wallets existing, vault SOL; a v1 · v2 split and the change against the previous period |
| Programs | one card per program: Live, Building history, Not deployed yet (v2 mainnet, with the expected build), Retired: migration only (v1 sunset), Unrecognised build, Dormant (no transaction in 30 days) |
| Activity | transactions (stacked by version, failed line), wallets created, active wallets (always per day/hour: distinct counts are never summed), protocol fees; `all` is re-binned to weeks (≤ 180 days of history) or months; each chart has a data table |
| Program detail | per version: instruction mix, signers, failure classes, integrators, programs wallets call, relayers, SIMD-0385 share; on-chain state; fee config, treasury (unwithdrawn vs withdrawable now), fee records, shards, fee coverage |
| Binaries and upgrades | deployed ELF sha256 and size, match against `release-hashes.txt` / known dumps, last deploy, upgrade authority, the expected next build (v1 sunset, v2 mainnet release), deploy history |
| Migration v1 → v2 | before Phase B what is left on v1; once the sunset build is live, migrations per day and cumulative, SOL and token accounts moved, % migrated, leftovers, retired calls |
| Latest activity | the 50 newest transactions with a LazorKit instruction of the selected version (the API sends 50 per program, so a quiet version is not crowded out), 10 per page, with explorer links (`?cluster=devnet` on devnet); it reads the event log, so it covers recent weeks, and an empty list says when the last transaction was |
| Developer details | collapsed: sync per program, invariant checks, runs, heartbeats, what started the last run, workflow state, metric definitions |

The last good payload per (cluster, window) is kept in `localStorage` (newest four; every access in try/catch), so a
paused database shows the saved copy under the red banner instead of an empty page. `setup_required` (migration not
applied) renders a banner and an explanation, never an error page. Light and dark themes follow the OS until the
viewer picks one. Lamports below 0.001 SOL are shown as lamports, larger amounts as SOL with at most four decimals;
hovering shows the exact lamports. Opening the page with `#all-details` expands every collapsible section.

Screenshots of every state, taken on the local stack: [`docs/preview/`](docs/preview/).

## Development

```bash
npm ci
npx supabase start                    # local Postgres + PostgREST (Docker)
npx supabase db reset                 # applies every migration
npx supabase test db                  # pgTAP (supabase/tests)
eval "$(npx supabase status -o env | sed 's/^/export LOCAL_/')"   # local test keys; never print them
export SUPABASE_URL=$LOCAL_API_URL SUPABASE_SERVICE_ROLE_KEY=$LOCAL_SERVICE_ROLE_KEY SUPABASE_ANON_KEY=$LOCAL_ANON_KEY
INDEXER_TX_CACHE_DIR=/tmp/lk-txcache npm run indexer -- --budget-minutes 90   # backfill from public RPC
npm run indexer -- --budget-minutes 5  # a second run fetches only new signatures
npm run verify:chain                   # per-day signature counts vs the chain: 0 mismatches
npm run dev:api                        # http://127.0.0.1:8787 (reads .env.api / .env.api.local)
npm run dev:web                        # Vite, proxies /api
```

Checks: `npm run typecheck`, `npm run lint`, `npm test` (unit, including server-rendering every payload fixture),
`npm run test:it` (local PostgREST), `npm run test:db` (pgTAP), `npm run build`. Parser fixtures are real transactions fetched read-only (`npm run fixtures:fetch`); three cases
never seen on chain (WithdrawTreasury, MigrateWallet, a CPI'd CreateWallet) are labelled synthetic fixtures.

Keep RPC URLs and the service-role key out of `VITE_*` variables (they are compiled into the browser bundle) and out
of the Vercel functions, which only read Supabase.
