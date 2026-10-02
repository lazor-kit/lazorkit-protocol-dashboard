// Payload contract shared by the API (api/dashboard.ts), the SPA and the worker's state writer.
// Spec §10.2 (payload) and §7.2 (StateTotals). Lamport amounts are strings (u64 safe).

import type { Cluster } from './protocol.js';

export type { Cluster } from './protocol.js';
export type DashboardWindow = '24h' | '7d' | '30d' | 'all';
export type ScopeKey = 'cluster' | '1' | '2' | '3' | '4';
export type Lamports = string;
export type FreshnessState = 'live' | 'catching_up' | 'delayed' | 'stale' | 'unavailable' | 'setup_required';
export type FailClass = 'lazorkit' | 'duplicate' | 'cpi' | 'limits' | 'other_ix' | 'retired' | 'noise' | 'other';
export type DeployStatus = 'unknown' | 'not_deployed' | 'live' | 'closed';
export type BinaryKind = 'v1-full' | 'v1-sunset' | 'v2-full' | 'unknown';
export type RunStatus = 'idle' | 'ok' | 'lagging' | 'failed' | 'not_deployed';
export type WorkflowState = 'active' | 'disabled_inactivity' | 'disabled_manually' | 'unknown';

export const DASHBOARD_API_VERSION = 2 as const;
/** lk.meta schema_version the API and the worker expect (supabase/migrations/20261002000100_lk_event_log.sql). */
export const EXPECTED_DB_SCHEMA_VERSION = 1;

export const DASHBOARD_WINDOWS: readonly DashboardWindow[] = ['24h', '7d', '30d', 'all'];
export const CLUSTERS: readonly Cluster[] = ['mainnet', 'devnet'];

export function isCluster(value: unknown): value is Cluster {
  return value === 'mainnet' || value === 'devnet';
}

export function isDashboardWindow(value: unknown): value is DashboardWindow {
  return value === '24h' || value === '7d' || value === '30d' || value === 'all';
}

export interface DashboardPayload {
  apiVersion: typeof DASHBOARD_API_VERSION;
  dbSchemaVersion: number | null;
  cluster: Cluster;
  window: DashboardWindow;
  generatedAt: string;
  // previous period = [previousStart, previousEnd): the same elapsed span as the current one, one period earlier
  range: { start: string | null; end: string; previousStart: string | null; previousEnd?: string | null; bucket: 'hour' | 'day' };
  freshness: Freshness;
  programs: ProgramView[]; // ordered v1, v2
  kpis: Partial<Record<ScopeKey, { current: Kpis; previous: Kpis | null }>>; // 'cluster' + each programKey
  series: SeriesPoint[];
  breakdowns: Partial<Record<ScopeKey, Breakdowns>>;
  migration: MigrationView | null;
  binaries: KnownBinary[];
  latest: LatestRow[]; // the 50 newest per program, newest first
  runs: RunRow[]; // last 20
}

export interface FreshnessReason {
  code:
    | 'never_run'
    | 'backfill'
    | 'backlog'
    | 'worker_old'
    | 'program_failing'
    | 'workflow_disabled'
    | 'db_unavailable'
    | 'schema_missing';
  programKey?: number;
  detail: string;
}

export interface Freshness {
  state: FreshnessState;
  completeThrough: string | null; // min over live programs of lk.complete_through
  lastWorkerRunAt: string | null; // heartbeats.worker.at
  // what started that run: GITHUB_EVENT_NAME (schedule | repository_dispatch | workflow_dispatch | push) or 'local';
  // null when not recorded (older worker, or a run that stopped before its final heartbeat). Absent in old payloads.
  lastWorkerTrigger: string | null; // heartbeats.worker.detail.trigger
  workflow: {
    state: WorkflowState;
    checkedAt: string | null;
    lastScheduledRunAt: string | null;
    lastConclusion: string | null;
  };
  reasons: FreshnessReason[];
  catchUp: Array<{ programKey: number; pending: number; ingested: number; percent: number | null }>;
}

export interface DeployHistoryEntry {
  slot: number;
  op: 'deploy' | 'upgrade' | 'extend' | 'observed';
  at: string | null;
  signature: string | null;
  sha256: string | null;
}

export interface ProgramView {
  programKey: number;
  cluster: Cluster;
  version: 1 | 2;
  programId: string;
  label: string;
  deployment: {
    status: DeployStatus;
    binaryKind: BinaryKind | null;
    binaryLabel: string | null;
    sha256: string | null;
    elfSize: number | null;
    releaseMatch: { feature: string | null; source: string } | null; // null = unrecognised
    lastDeploySlot: number | null;
    deployedAt: string | null;
    upgradeAuthority: string | null;
    history: DeployHistoryEntry[];
  };
  sync: {
    activeGen: number;
    parserVersion: number;
    backfillComplete: boolean;
    historyProof: 'deploy_tx' | 'archival_end' | null;
    firstActivityAt: string | null;
    completeThrough: string | null;
    discoveredAt: string | null;
    pending: number;
    ingested: number;
    gapsOpen: number;
    lastActivityAt: string | null;
    lastRunStatus: RunStatus;
    lastError: string | null;
    consecutiveFailures: number;
    lastSuccessAt: string | null;
    lastRunFinishedAt: string | null;
    building: null | { gen: number; parserVersion: number; pending: number; ingested: number; backfillComplete: boolean };
  };
  state: StateTotals | null;
  stateDetail: StateDetail | null; // per-shard list and FeeRecords (when 50 or fewer)
  stateSlot: number | null;
  stateFetchedAt: string | null;
  treasury: null | {
    fundingLamports: Lamports;
    feesLamports: Lamports;
    withdrawnLamports: Lamports;
    unwithdrawnFeesLamports: Lamports;
    withdrawableNowLamports: Lamports;
    excessRentLamports: Lamports;
  };
  checks: CheckResult[];
}

export interface Kpis {
  signatures: number;
  txs: number;
  txsOk: number;
  txsFailed: number;
  failByClass: Partial<Record<FailClass, number>>;
  noiseTxs: number;
  unparsedTxs: number;
  ixs: number;
  walletsCreated: number;
  walletsCreatedPasskey: number;
  activeWallets: number;
  payers: number;
  apps: number;
  executes: number;
  feeLamports: Lamports;
  feeEvents: number;
  feeEligibleOk: number;
  feeSuffixOk: number;
  migrations: number;
  migratedLamports: Lamports;
  migratedTokenAccounts: number;
  shardFundingLamports: Lamports;
  withdrawnLamports: Lamports;
  netFeeLamports: Lamports;
  cleanupLamports: Lamports;
  retiredCalls: number;
  txv1: number;
}

export interface SeriesPoint {
  scope: ScopeKey;
  bucket: string; // 'YYYY-MM-DD' (day) or 'YYYY-MM-DDTHH:00:00Z' (hour)
  txs: number;
  txsFailed: number;
  walletsCreated: number;
  activeWallets: number;
  executes: number;
  feeLamports: Lamports;
  feeEvents: number;
  migrations: number;
}

export interface Breakdowns {
  byKind: Record<string, { ok: number; fail: number }>;
  byAuth: Partial<Record<'passkey' | 'session' | 'ed25519' | 'deferred' | 'unknown', number>>;
  byFail: Partial<Record<FailClass, number>>;
  byApp: Array<{ app: string; created: number; ops: number }>; // top 10
  byPayer: Array<{ payer: string; txs: number }>; // top 10
  byCpi: Array<{ program: string; executes: number }>; // top 10
}

export interface MigrationView {
  status: 'not_started' | 'active'; // active once the v1 build is v1-sunset or migrations > 0
  v1ProgramKey: number;
  v2ProgramKey: number;
  v1BinaryKind: string | null;
  totals: { migrations: number; migratedLamports: Lamports; tokenAccounts: number };
  series: Array<{ day: string; migrations: number }>;
  v1WalletsRemaining: number | null;
  v1RemainingVaultLamports: Lamports | null;
  percentMigrated: number | null;
  v2WalletsFromMigration: number;
  v2WalletsNew: number;
  leftovers: { v1Sessions: number | null; v1Deferred: number | null };
  cleanup: { reclaimDeferred: number; closeExpiredSession: number; lamports: Lamports };
  retiredCalls: number;
}

export interface KnownBinary {
  sha256: string;
  elfSize: number;
  kind: 'v1-full' | 'v1-sunset' | 'v2-full';
  cluster: Cluster | null;
  releaseFeature: string | null;
  label: string;
  source: string;
}

export interface LatestRow {
  programKey: number;
  version: 1 | 2;
  signature: string;
  blockTime: string;
  slot: number;
  kinds: number[];
  ok: boolean;
  failClass: FailClass | null;
  errCode: number | null;
  wallet: string | null;
  payer: string | null;
  auth: number | null;
  feeLamports: Lamports;
  app: string | null;
  txVersion: number | null;
  inner: boolean;
}

export interface RunRow {
  runId: string;
  startedAt: string;
  finishedAt: string | null;
  status: string | null;
}

export interface CheckResult {
  id: 'I1' | 'I2' | 'I3' | 'I4' | 'I5' | 'I6' | 'R1';
  label: string;
  expected: string | null;
  actual: string | null;
  ok: boolean | null;
  mode: 'enforce' | 'informational' | 'pending';
  note: string | null;
}

// ------------------------------------------------------------------------------------------------ state (§7.2)

export interface FeeRecordView {
  address: string;
  totalFeesPaid: Lamports;
  txCount: number;
  walletCount: number;
  registeredSlot: number;
}

export interface StateTotals {
  slot: number;
  accounts: number;
  wallets: number; // S2
  multiOwnerWallets: number | null; // v2: owner_count > 1; v1: null
  authorities: {
    total: number;
    owner: number;
    admin: number;
    delegate: number;
    passkey: number;
    ed25519: number;
    legacyLayout: number;
  }; // S4
  ownerTypes: { passkeyWallets: number; ed25519Wallets: number; mixedWallets: number }; // S3
  passkeyOpsLifetime: number; // S6
  sessions: { total: number; live: number; expired: number; withPolicy: number }; // S7
  deferred: { total: number; pending: number; expired: number; expiredLamports: Lamports }; // S8
  config: null | {
    address: string;
    enabled: boolean;
    numShards: number;
    admin: string;
    treasury: string;
    creationFee: Lamports;
    executionFee: Lamports;
    pendingAdmin: string | null;
  }; // S9
  feeRecords: {
    count: number;
    totalFeesPaid: Lamports;
    txCount: number;
    walletCount: number;
    top: FeeRecordView[];
  }; // S10, top 10
  treasury: { shards: number; lamports: Lamports; withdrawableNow: Lamports }; // S11
  vaults: { funded: number; lamports: Lamports }; // S12 (SOL only)
  rentMinimum8: Lamports;
  unknownAccounts: number;
}

export interface StateDetail {
  shards: Array<{ id: number; address: string; lamports: Lamports }>;
  feeRecords: FeeRecordView[] | null; // full list when 50 entries or fewer
}

// ------------------------------------------------------------------------------------------------ health

export interface HealthProgram {
  programKey: number;
  cluster: Cluster;
  version: 1 | 2;
  label: string;
  programId: string;
  deployStatus: DeployStatus;
  binaryKind: BinaryKind | null;
  lastRunStatus: RunStatus;
  lastError: string | null;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastRunFinishedAt: string | null;
  activeGen: number;
  backfillComplete: boolean;
  pending: number;
  gapsOpen: number;
  ingested: number;
  completeThrough: string | null;
  discoveredAt: string | null;
  checks: CheckResult[];
}

export interface HeartbeatRow {
  at: string;
  detail: Record<string, unknown>;
}

export type Heartbeats = Partial<Record<'worker' | 'vercel-cron', HeartbeatRow>> & Record<string, HeartbeatRow>;

export interface HealthPayload {
  apiVersion: typeof DASHBOARD_API_VERSION;
  status: FreshnessState;
  dbSchemaVersion: number | null;
  generatedAt: string;
  completeThrough: string | null;
  lastWorkerRunAt: string | null;
  lastWorkerTrigger: string | null;
  workflowState: WorkflowState;
  freshness: Freshness;
  programs: HealthProgram[];
}
