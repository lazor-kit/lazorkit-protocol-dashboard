// Pure view selectors over the payload (spec §11). No React, no DOM, so every rule here is unit-tested.

import {
  type Cluster,
  type DashboardPayload,
  type DashboardWindow,
  type FailClass,
  type Freshness,
  type FreshnessState,
  type KnownBinary,
  type Kpis,
  type ProgramView,
  type ScopeKey,
  type SeriesPoint,
} from '../types/dashboard';
import { PROGRAMS, programByKey } from '../types/protocol';
import { formatAge, formatBytes, formatInteger, formatUtc, shortHash, toBigInt } from '../lib/format';
import type { VersionFilter } from './urlState';

// ------------------------------------------------------------------------------------------------ scopes

export interface ClusterKeys {
  v1: number;
  v2: number;
}

export function clusterKeys(cluster: Cluster): ClusterKeys {
  const v1 = PROGRAMS.find((program) => program.cluster === cluster && program.version === 1);
  const v2 = PROGRAMS.find((program) => program.cluster === cluster && program.version === 2);
  return { v1: v1?.programKey ?? (cluster === 'mainnet' ? 1 : 3), v2: v2?.programKey ?? (cluster === 'mainnet' ? 2 : 4) };
}

export function scopeForVersion(cluster: Cluster, version: VersionFilter): ScopeKey {
  if (version === 'all') return 'cluster';
  const keys = clusterKeys(cluster);
  return String(version === '1' ? keys.v1 : keys.v2) as ScopeKey;
}

export function programLabel(programKey: number, programs: ProgramView[] = []): string {
  return programs.find((program) => program.programKey === programKey)?.label ?? programByKey(programKey)?.label ?? `program ${programKey}`;
}

export function visiblePrograms(payload: DashboardPayload, version: VersionFilter): ProgramView[] {
  const ordered = [...payload.programs].sort((a, b) => a.version - b.version || a.programKey - b.programKey);
  return version === 'all' ? ordered : ordered.filter((program) => String(program.version) === version);
}

export function isDeployed(program: ProgramView): boolean {
  return program.deployment.status === 'live';
}

// ------------------------------------------------------------------------------------------------ freshness

export type Tone = 'good' | 'info' | 'warning' | 'danger' | 'neutral';

export const FRESHNESS_LABELS: Record<FreshnessState, string> = {
  live: 'Live',
  catching_up: 'Catching up',
  delayed: 'Delayed',
  stale: 'Stale',
  unavailable: 'Unavailable',
  setup_required: 'Setup required',
};

export const FRESHNESS_TONES: Record<FreshnessState, Tone> = {
  live: 'good',
  catching_up: 'info',
  delayed: 'warning',
  stale: 'danger',
  unavailable: 'danger',
  setup_required: 'warning',
};

export interface BannerModel {
  state: FreshnessState;
  tone: Tone;
  label: string;
  messages: string[];
  command: string | null;
}

/**
 * The freshness banner (spec §10.3 / §11.2 item 2). `live` has no banner. `cachedAt` is the time the copy shown
 * under an `unavailable` banner was saved in this browser (null when there is none).
 */
export function selectBanner(input: {
  freshness: Freshness;
  programs: ProgramView[];
  now: number;
  cachedAt?: string | null;
}): BannerModel | null {
  const { freshness, programs, now } = input;
  const state = freshness.state;
  if (state === 'live') return null;
  const through = freshness.completeThrough;
  const messages: string[] = [];
  let command: string | null = null;

  if (state === 'setup_required') {
    messages.push(
      'Backend upgrade pending: the database migration for this version has not been applied yet. Production data is unaffected.',
    );
  } else if (state === 'unavailable') {
    messages.push(
      input.cachedAt
        ? `Data service unavailable (the database may be paused). Showing the copy saved in this browser from ${formatUtc(input.cachedAt, now, { alwaysDate: true })} (${formatAge(input.cachedAt, now)}).`
        : 'Data service unavailable (the database may be paused). There is no copy saved in this browser yet; try again shortly.',
    );
  } else if (state === 'stale') {
    const asOf = through ?? freshness.lastWorkerRunAt;
    messages.push(`The indexer has stopped. Figures are as of ${asOf ? formatUtc(asOf, now, { alwaysDate: true }) : 'its last run'}.`);
    if (freshness.workflow.state === 'disabled_inactivity') {
      messages.push('Reason: GitHub disabled the scheduled workflow (inactivity). Maintainers:');
      command = 'gh workflow enable indexer.yml';
    } else if (freshness.workflow.state === 'disabled_manually') {
      messages.push('Reason: the scheduled indexer workflow is disabled. Maintainers:');
      command = 'gh workflow enable indexer.yml';
    } else if (freshness.lastWorkerRunAt) {
      messages.push(`The last indexer run finished ${formatAge(freshness.lastWorkerRunAt, now)}.`);
    }
  } else if (state === 'delayed') {
    const last = freshness.lastWorkerRunAt;
    messages.push(
      `Updates are delayed. ${last ? `The last indexer run finished ${formatAge(last, now)}` : 'The indexer has not reported recently'}; figures are complete through ${through ? formatUtc(through, now) : 'the last successful run'}.`,
    );
    for (const reason of freshness.reasons) if (reason.code === 'program_failing') messages.push(reason.detail);
  } else if (state === 'catching_up') {
    if (freshness.reasons.some((reason) => reason.code === 'never_run')) {
      messages.push('Catching up: the indexer has not run yet. Figures appear after its first run.');
    }
    for (const reason of freshness.reasons) {
      if (reason.programKey === undefined) continue;
      const label = programLabel(reason.programKey, programs);
      const progress = freshness.catchUp.find((entry) => entry.programKey === reason.programKey);
      if (reason.code === 'backfill') {
        const pending = progress?.pending ?? 0;
        const ingested = progress?.ingested ?? 0;
        const percent = progress?.percent;
        messages.push(
          `Building history for ${label}: ${percent === null || percent === undefined ? '–' : `${Math.floor(percent)} %`} (${formatInteger(ingested)} of ${formatInteger(ingested + pending)} transactions). Figures below are partial.`,
        );
      } else if (reason.code === 'backlog') {
        const programThrough = programs.find((program) => program.programKey === reason.programKey)?.sync.completeThrough ?? through;
        messages.push(
          `Catching up: ${formatInteger(progress?.pending ?? 0)} new transactions pending for ${label}. Figures are complete through ${programThrough ? formatUtc(programThrough, now) : '–'}.`,
        );
      }
    }
    if (messages.length === 0) messages.push('Catching up: the indexer is processing new transactions.');
  }
  return { state, tone: FRESHNESS_TONES[state], label: FRESHNESS_LABELS[state], messages, command };
}

// ------------------------------------------------------------------------------------------------ KPIs

export interface Delta {
  label: string;
  direction: 'up' | 'down' | 'flat' | 'none';
}

/** "+12.5%", "−3%", "0%", "new" (previous 0, current > 0); null previous (window `all`) → no delta. */
export function kpiDelta(current: number, previous: number | null | undefined): Delta {
  if (previous === null || previous === undefined) return { label: '', direction: 'none' };
  if (previous === 0) return current === 0 ? { label: '0%', direction: 'flat' } : { label: 'new', direction: 'up' };
  const change = (current - previous) / previous;
  if (Math.abs(change) < 0.0005) return { label: '0%', direction: 'flat' };
  const pct = Math.abs(change * 100);
  const text = pct >= 100 ? Math.round(pct).toString() : pct.toFixed(1).replace(/\.0$/, '');
  return { label: `${change > 0 ? '+' : '−'}${text}%`, direction: change > 0 ? 'up' : 'down' };
}

export function windowLabel(window: DashboardWindow): string {
  return window === '24h' ? 'last 24 hours' : window === '7d' ? 'last 7 days' : window === '30d' ? 'last 30 days' : 'all history';
}

export function previousLabel(window: DashboardWindow): string {
  return window === '24h' ? 'vs previous 24 h' : window === '7d' ? 'vs previous 7 days' : window === '30d' ? 'vs previous 30 days' : '';
}

export function kpisFor(payload: DashboardPayload, scope: ScopeKey): { current: Kpis; previous: Kpis | null } | null {
  return payload.kpis[scope] ?? null;
}

/** "v1 467 · v2 0" style split for a numeric KPI; `null` per side when that program has no KPIs. */
export function versionSplit(payload: DashboardPayload, pick: (kpis: Kpis) => number): { v1: number | null; v2: number | null } {
  const keys = clusterKeys(payload.cluster);
  const v1 = payload.kpis[String(keys.v1) as ScopeKey]?.current;
  const v2 = payload.kpis[String(keys.v2) as ScopeKey]?.current;
  return { v1: v1 ? pick(v1) : null, v2: v2 ? pick(v2) : null };
}

export interface StateSummary {
  wallets: number;
  vaultLamports: bigint;
  fundedVaults: number;
  perVersion: { v1: { wallets: number; vaultLamports: bigint } | null; v2: { wallets: number; vaultLamports: bigint } | null };
  slot: number | null;
  fetchedAt: string | null;
  programs: number;
}

/** State KPIs (wallets existing, vault SOL) summed over the deployed programs in view (spec §8.3). */
export function stateSummary(payload: DashboardPayload, version: VersionFilter): StateSummary {
  const summary: StateSummary = {
    wallets: 0,
    vaultLamports: 0n,
    fundedVaults: 0,
    perVersion: { v1: null, v2: null },
    slot: null,
    fetchedAt: null,
    programs: 0,
  };
  for (const program of payload.programs) {
    if (!program.state) continue;
    const entry = { wallets: program.state.wallets, vaultLamports: toBigInt(program.state.vaults.lamports) };
    summary.perVersion[program.version === 1 ? 'v1' : 'v2'] = entry;
    if (version !== 'all' && String(program.version) !== version) continue;
    summary.wallets += entry.wallets;
    summary.vaultLamports += entry.vaultLamports;
    summary.fundedVaults += program.state.vaults.funded;
    summary.programs += 1;
    summary.slot = Math.max(summary.slot ?? 0, program.stateSlot ?? program.state.slot);
    if (!summary.fetchedAt || (program.stateFetchedAt && program.stateFetchedAt < summary.fetchedAt)) {
      summary.fetchedAt = program.stateFetchedAt ?? summary.fetchedAt;
    }
  }
  return summary;
}

// ------------------------------------------------------------------------------------------------ programs

export const DORMANT_AFTER_DAYS = 30;

export interface ProgramBadge {
  label: string;
  tone: Tone;
  kind: 'live' | 'not_deployed' | 'retired' | 'unrecognised' | 'dormant' | 'closed' | 'unknown';
}

export function programBadge(program: ProgramView, now: number): ProgramBadge {
  const { status, binaryKind, releaseMatch } = program.deployment;
  if (status === 'not_deployed') return { label: 'Not deployed yet', tone: 'neutral', kind: 'not_deployed' };
  if (status === 'closed') return { label: 'Closed', tone: 'danger', kind: 'closed' };
  if (status !== 'live') return { label: 'Status unknown', tone: 'neutral', kind: 'unknown' };
  if (binaryKind === 'v1-sunset') return { label: 'Retired: migration only', tone: 'warning', kind: 'retired' };
  if (binaryKind === 'unknown' || binaryKind === null || releaseMatch === null) {
    return { label: 'Unrecognised build', tone: 'danger', kind: 'unrecognised' };
  }
  const last = program.sync.lastActivityAt ? Date.parse(program.sync.lastActivityAt) : Number.NaN;
  if (!Number.isFinite(last) || now - last > DORMANT_AFTER_DAYS * 86_400_000) {
    return { label: 'Dormant', tone: 'neutral', kind: 'dormant' };
  }
  return { label: 'Live', tone: 'good', kind: 'live' };
}

export function backfillPercent(program: ProgramView): number | null {
  const total = program.sync.ingested + program.sync.pending;
  if (program.sync.backfillComplete && program.sync.pending === 0) return 100;
  return total > 0 ? Math.floor((1000 * program.sync.ingested) / total) / 10 : null;
}

/** The build a not-deployed program is expected to get, or the next planned build of a deployed one. */
export function expectedNextBinary(program: ProgramView, binaries: KnownBinary[]): { label: string; binary: KnownBinary } | null {
  const sameCluster = binaries.filter((binary) => binary.cluster === program.cluster || binary.cluster === null);
  if (program.version === 1) {
    if (program.deployment.binaryKind === 'v1-sunset') return null;
    const sunset = sameCluster.find((binary) => binary.kind === 'v1-sunset');
    return sunset ? { label: 'Phase B: v1 sunset', binary: sunset } : null;
  }
  const release = sameCluster.find((binary) => binary.kind === 'v2-full' && binary.releaseFeature !== null) ??
    sameCluster.find((binary) => binary.kind === 'v2-full');
  if (!release) return null;
  if (program.deployment.status !== 'live') return { label: 'v2 release', binary: release };
  if (program.deployment.sha256 === release.sha256) return null;
  return { label: 'v2 release', binary: release };
}

export function releaseMatchLabel(program: ProgramView): { text: string; ok: boolean | null; title: string | null } {
  const { status, releaseMatch, binaryLabel } = program.deployment;
  if (status !== 'live') return { text: '–', ok: null, title: null };
  if (!releaseMatch) return { text: '✗ unrecognised build', ok: false, title: 'The deployed ELF hash is not in the known-builds table' };
  if (releaseMatch.feature) {
    return { text: `✓ matches release-hashes.txt · ${releaseMatch.feature}`, ok: true, title: releaseMatch.source };
  }
  return { text: `✓ matches known build: ${binaryLabel ?? 'program dump'}`, ok: true, title: releaseMatch.source };
}

export function notDeployedCopy(program: ProgramView, binaries: KnownBinary[]): string {
  const clusterName = program.cluster === 'mainnet' ? 'mainnet' : 'devnet';
  const expected = expectedNextBinary(program, binaries);
  const build = expected ? ` (expected build ${shortHash(expected.binary.sha256)}, ${formatBytes(expected.binary.elfSize)})` : '';
  return `${program.programId.slice(0, 9)}… has no account on ${clusterName}. It will be picked up automatically on its first deploy${build}.`;
}

// ------------------------------------------------------------------------------------------------ series

export type BinSize = 'hour' | 'day' | 'week' | 'month';

export function historyDays(payload: Pick<DashboardPayload, 'range'>): number {
  const start = payload.range.start ? Date.parse(payload.range.start) : Number.NaN;
  const end = Date.parse(payload.range.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, (end - start) / 86_400_000);
}

/** 24h → hourly; 7d/30d → daily; all → weekly up to 180 days of history, monthly beyond. */
export function binSizeFor(window: DashboardWindow, days: number): BinSize {
  if (window === '24h') return 'hour';
  if (window !== 'all') return 'day';
  return days <= 180 ? 'week' : 'month';
}

export function binStart(bucket: string, size: BinSize): string {
  if (size === 'hour' || size === 'day') return bucket;
  const date = new Date(`${bucket.slice(0, 10)}T00:00:00Z`);
  if (size === 'month') return `${bucket.slice(0, 7)}-01`;
  const weekday = (date.getUTCDay() + 6) % 7; // Monday = 0
  date.setUTCDate(date.getUTCDate() - weekday);
  return date.toISOString().slice(0, 10);
}

export const ADDITIVE_FIELDS = ['txs', 'txsFailed', 'walletsCreated', 'executes', 'feeEvents', 'migrations'] as const;

export interface ChartRow {
  bucket: string;
  v1: number;
  v2: number;
  total: number;
  failed: number;
}

export type ChartMetric = 'txs' | 'walletsCreated' | 'activeWallets' | 'fees';

function metricValue(point: SeriesPoint, metric: ChartMetric): number {
  if (metric === 'fees') return Number(toBigInt(point.feeLamports));
  return point[metric];
}

/**
 * Rows for a stacked-by-version chart. Additive metrics re-bin to weeks/months for `all`; active wallets are
 * distinct counts and are never summed across days, so they always stay at the payload's bucket size.
 * `total` is the de-duplicated cluster (or single-program) value; `failed` the failed transactions overlay.
 */
export function chartRows(payload: DashboardPayload, metric: ChartMetric, version: VersionFilter): { rows: ChartRow[]; size: BinSize } {
  const keys = clusterKeys(payload.cluster);
  const rebin = binSizeFor(payload.window, historyDays(payload));
  const size: BinSize = metric === 'activeWallets' ? (payload.window === '24h' ? 'hour' : 'day') : rebin;
  const totalScope = scopeForVersion(payload.cluster, version);
  const byBucket = new Map<string, ChartRow>();
  const row = (bucket: string) => {
    const key = binStart(bucket, size);
    let entry = byBucket.get(key);
    if (!entry) {
      entry = { bucket: key, v1: 0, v2: 0, total: 0, failed: 0 };
      byBucket.set(key, entry);
    }
    return entry;
  };
  for (const point of payload.series) {
    const entry = row(point.bucket);
    const value = metricValue(point, metric);
    if (point.scope === String(keys.v1) && version !== '2') entry.v1 += value;
    if (point.scope === String(keys.v2) && version !== '1') entry.v2 += value;
    if (point.scope === totalScope) {
      entry.total += value;
      entry.failed += point.txsFailed;
    }
  }
  return { rows: [...byBucket.values()].sort((a, b) => a.bucket.localeCompare(b.bucket)), size };
}

// ------------------------------------------------------------------------------------------------ labels

export const AUTH_LABELS: Record<string, string> = {
  passkey: 'Passkey',
  session: 'Session key',
  ed25519: 'Ed25519 key',
  deferred: 'Deferred (pre-authorized)',
  unknown: 'Unknown',
};

export const AUTH_BY_CODE: Record<number, string> = { 1: 'Passkey', 2: 'Session', 3: 'Ed25519', 4: 'Deferred' };

export const FAIL_LABELS: Record<FailClass, string> = {
  lazorkit: 'LazorKit error',
  duplicate: 'Duplicate submit',
  cpi: 'Called program failed',
  limits: 'Compute / data limits',
  other_ix: 'Other instruction failed',
  retired: 'Retired v1 call',
  noise: 'Noise',
  other: 'Other',
};

/** Programs wallets call through Execute, named only where the id is unambiguous. */
export const KNOWN_PROGRAMS: Record<string, string> = {
  '11111111111111111111111111111111': 'System Program',
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: 'SPL Token',
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: 'Token-2022',
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: 'Associated Token Account',
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: 'Jupiter v6',
  DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH: 'DFlow',
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: 'Memo',
  noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV: 'SPL Noop',
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: 'Orca Whirlpool',
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: 'Meteora DLMM',
};

export function txVersionLabel(version: number | null): string {
  if (version === null) return '–';
  if (version < 0) return 'legacy';
  return `v${version}`;
}
