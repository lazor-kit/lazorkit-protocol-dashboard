import type {
  AnalyticsStatus,
  DashboardKpis,
  DashboardStats,
  DashboardWindow,
  KpiValue,
  LatestTransaction,
  LatestTransactionsPagination,
  NetworkComparison,
  SeriesPoint,
} from '../../src/solana/dashboardTypes.js';
import type { ProtocolStats } from '../../src/solana/protocolStatsTypes.js';
import { isDashboardWindow } from '../../src/solana/dashboardTypes.js';
import { type ClusterId } from '../../src/solana/shared.js';
import {
  SupabaseNotConfiguredError,
  SupabaseRestClient,
  type DashboardTransactionRow,
  type IndexedTransactionBoundary,
  type IndexerCursorRow,
  type IndexerState,
} from './database.js';

export const DASHBOARD_CACHE_TTL_SECONDS = 300;
export const DEFAULT_TX_PAGE = 1;
export const DEFAULT_TX_LIMIT = 10;
export const ALLOWED_TX_LIMITS = [10, 15] as const;
const ALL_TIME_START_ISO = '1970-01-01T00:00:00.000Z';
const STALE_AFTER_MS = 15 * 60 * 1000;

export interface DashboardPaginationOptions {
  txPage: number;
  txLimit: 10 | 15;
}

interface DashboardCacheEntry {
  expiresAt: number;
  stats: DashboardStats;
}

const dashboardCache = new Map<string, DashboardCacheEntry>();

export function parseDashboardWindow(value: unknown): DashboardWindow {
  return isDashboardWindow(value) ? value : 'all';
}

export function windowToMs(window: Exclude<DashboardWindow, 'all'>): number {
  if (window === '24h') return 24 * 60 * 60 * 1000;
  if (window === '7d') return 7 * 24 * 60 * 60 * 1000;
  return 30 * 24 * 60 * 60 * 1000;
}

export function parseDashboardPagination(params: {
  txPage?: unknown;
  txLimit?: unknown;
}): DashboardPaginationOptions | null {
  const txPage = parseOptionalPositiveInteger(params.txPage, DEFAULT_TX_PAGE);
  const txLimit = parseOptionalPositiveInteger(params.txLimit, DEFAULT_TX_LIMIT);

  if (txPage === null || txLimit === null) return null;
  if (!ALLOWED_TX_LIMITS.includes(txLimit as 10 | 15)) return null;

  return {
    txPage,
    txLimit: txLimit as 10 | 15,
  };
}

export async function getDashboardStats(
  cluster: ClusterId,
  window: DashboardWindow,
  pagination: DashboardPaginationOptions = {
    txPage: DEFAULT_TX_PAGE,
    txLimit: DEFAULT_TX_LIMIT,
  },
): Promise<DashboardStats> {
  const now = Date.now();
  const cacheKey = `${cluster}:${window}:${pagination.txPage}:${pagination.txLimit}`;
  const cached = dashboardCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return {
      ...cached.stats,
      health: {
        ...cached.stats.health,
        cacheHit: true,
        cacheTtlSeconds: Math.ceil((cached.expiresAt - now) / 1000),
      },
    };
  }

  let db: SupabaseRestClient | null = null;
  try {
    db = new SupabaseRestClient();
    const snapshot = await db.getDashboardSnapshot({ cluster, cacheKey, nowMs: now });
    if (snapshot) {
      dashboardCache.set(cacheKey, {
        stats: snapshot,
        expiresAt: now + snapshot.health.cacheTtlSeconds * 1000,
      });
      return snapshot;
    }
  } catch (error) {
    if (!(error instanceof SupabaseNotConfiguredError)) throw error;
  }

  const stats = await buildDashboardStats(cluster, window, now, pagination, db);
  dashboardCache.set(cacheKey, {
    stats,
    expiresAt: now + DASHBOARD_CACHE_TTL_SECONDS * 1000,
  });
  if (db && !stats.setupRequired) {
    await db
      .upsertDashboardSnapshot({
        cluster,
        cacheKey,
        stats,
        ttlSeconds: DASHBOARD_CACHE_TTL_SECONDS,
      })
      .catch(() => undefined);
  }
  return stats;
}

export async function refreshDashboardSnapshot(
  cluster: ClusterId,
  window: DashboardWindow,
  pagination: DashboardPaginationOptions = {
    txPage: DEFAULT_TX_PAGE,
    txLimit: DEFAULT_TX_LIMIT,
  },
): Promise<DashboardStats> {
  const now = Date.now();
  const cacheKey = `${cluster}:${window}:${pagination.txPage}:${pagination.txLimit}`;
  const db = new SupabaseRestClient();
  const stats = await buildDashboardStats(cluster, window, now, pagination, db);

  dashboardCache.set(cacheKey, {
    stats,
    expiresAt: now + DASHBOARD_CACHE_TTL_SECONDS * 1000,
  });
  await db.upsertDashboardSnapshot({
    cluster,
    cacheKey,
    stats,
    ttlSeconds: DASHBOARD_CACHE_TTL_SECONDS,
  });
  return stats;
}

async function buildDashboardStats(
  cluster: ClusterId,
  window: DashboardWindow,
  now: number,
  pagination: DashboardPaginationOptions,
  existingDb: SupabaseRestClient | null = null,
): Promise<DashboardStats> {
  let db: SupabaseRestClient;
  try {
    db = existingDb ?? new SupabaseRestClient();
  } catch (error) {
    if (error instanceof SupabaseNotConfiguredError) {
      return emptyDashboardStats(
        cluster,
        window,
        now,
        true,
        'not-initialized',
        null,
        pagination,
      );
    }
    throw error;
  }

  const isAllTime = window === 'all';
  const duration = isAllTime ? 0 : windowToMs(window);
  const currentStart = isAllTime
    ? ALL_TIME_START_ISO
    : new Date(now - duration).toISOString();
  const previousStart = isAllTime
    ? ALL_TIME_START_ISO
    : new Date(now - duration * 2).toISOString();
  const currentEnd = new Date(now).toISOString();

  const latestOffset = (pagination.txPage - 1) * pagination.txLimit;
  const [
    rows,
    latestTransactionsResult,
    cursor,
    indexerState,
    oldestIndexed,
    newestIndexed,
    protocolStats,
  ] = await Promise.all([
    db.selectDashboardTransactions({
      clusters: ['mainnet', 'devnet'],
      sinceIso: previousStart,
      untilIso: currentEnd,
      order: 'desc',
      limit: 20000,
    }),
    db.selectLatestDashboardTransactions({
      cluster,
      sinceIso: currentStart,
      untilIso: currentEnd,
      limit: pagination.txLimit,
      offset: latestOffset,
    }),
    db.getCursor(cluster),
    db.getIndexerState(cluster),
    db.getOldestIndexedTransaction(cluster),
    db.getNewestIndexedTransaction(cluster),
    db.getProtocolStatsSnapshot(cluster),
  ]);

  const selectedRows = rows.filter((row) => row.cluster === cluster);
  const currentRows = selectedRows.filter((row) => row.block_time >= currentStart);
  const previousRows = isAllTime
    ? []
    : rows.filter(
        (row) =>
          row.cluster === cluster &&
          row.block_time >= previousStart &&
          row.block_time < currentStart,
      );
  const comparisonRows = rows.filter((row) => row.block_time >= currentStart);

  const protocolStatus =
    !protocolStats || protocolStats.initialized === false
      ? 'not-initialized'
      : protocolStats?.config?.enabled
        ? 'enabled'
        : 'paused';
  const analyticsHealth = buildAnalyticsHealth({
    setupRequired: false,
    indexerState,
    oldestIndexed,
    newestIndexed,
    now,
  });

  return {
    cluster,
    window,
    generatedAt: new Date(now).toISOString(),
    setupRequired: false,
    protocolStats,
    health: {
      protocolStatus,
      ...analyticsHealth,
      lastIndexedSlot: cursor?.last_indexed_slot ?? null,
      lastIndexedAt: cursor?.last_indexed_at ?? null,
      cacheHit: false,
      cacheTtlSeconds: DASHBOARD_CACHE_TTL_SECONDS,
    },
    kpis: buildKpis(currentRows, previousRows),
    series: buildSeries(currentRows, window, now),
    latestTransactions: latestTransactionsResult.rows.map(toLatestTransaction),
    latestTransactionsPagination: buildPagination(
      pagination.txPage,
      pagination.txLimit,
      latestTransactionsResult.total,
    ),
    networkComparison: buildNetworkComparison(comparisonRows),
  };
}

export function buildPagination(
  page: number,
  limit: 10 | 15,
  total: number,
): LatestTransactionsPagination {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(Math.max(1, page), totalPages);
  return {
    page: safePage,
    limit,
    total,
    totalPages,
    hasPreviousPage: safePage > 1,
    hasNextPage: safePage < totalPages,
  };
}

export function classifyAnalyticsStatus(params: {
  setupRequired: boolean;
  hasIndexedRows: boolean;
  indexerState: IndexerState | null;
  now: number;
}): AnalyticsStatus {
  if (params.setupRequired) return 'not_configured';
  const { indexerState } = params;
  if (indexerState?.lastRunStatus === 'running') return 'indexing';
  if (indexerState?.lastRunStatus === 'failed') return 'error';
  if (!params.hasIndexedRows) return 'empty';
  if (!indexerState?.backfillComplete) return 'partial';

  const lastSuccessfulRunAt = indexerState.lastSuccessfulRunAt
    ? new Date(indexerState.lastSuccessfulRunAt).getTime()
    : null;
  if (!lastSuccessfulRunAt || params.now - lastSuccessfulRunAt > STALE_AFTER_MS) {
    return 'stale';
  }
  return 'fresh';
}

export function buildCoverageLabel(params: {
  oldestIndexedAt: string | null;
  newestIndexedAt: string | null;
  analyticsStatus: AnalyticsStatus;
}): string {
  if (params.analyticsStatus === 'not_configured') return 'Analytics not configured';
  if (!params.oldestIndexedAt || !params.newestIndexedAt) {
    return 'No indexed data yet';
  }
  const oldest = formatCoverageDate(params.oldestIndexedAt);
  const newest = formatCoverageDate(params.newestIndexedAt);
  const prefix =
    params.analyticsStatus === 'partial' || params.analyticsStatus === 'indexing'
      ? 'Backfilling'
      : 'Indexed';
  return oldest === newest ? `${prefix} ${oldest}` : `${prefix} ${oldest} - ${newest}`;
}

function buildAnalyticsHealth(params: {
  setupRequired: boolean;
  indexerState: IndexerState | null;
  oldestIndexed: IndexedTransactionBoundary | null;
  newestIndexed: IndexedTransactionBoundary | null;
  now: number;
}): Pick<
  DashboardStats['health'],
  | 'analyticsStatus'
  | 'dataCoverageLabel'
  | 'isBackfilling'
  | 'backfillComplete'
  | 'oldestIndexedAt'
  | 'newestIndexedAt'
  | 'lastRunStatus'
  | 'lastRunError'
  | 'lastRunWarningsCount'
  | 'lastSuccessfulRunAt'
> {
  const oldestIndexedAt =
    params.oldestIndexed?.block_time ?? params.indexerState?.oldestIndexedAt ?? null;
  const newestIndexedAt =
    params.newestIndexed?.block_time ?? params.indexerState?.newestIndexedAt ?? null;
  const analyticsStatus = classifyAnalyticsStatus({
    setupRequired: params.setupRequired,
    hasIndexedRows: Boolean(oldestIndexedAt || newestIndexedAt),
    indexerState: params.indexerState,
    now: params.now,
  });

  return {
    analyticsStatus,
    dataCoverageLabel: buildCoverageLabel({
      oldestIndexedAt,
      newestIndexedAt,
      analyticsStatus,
    }),
    isBackfilling: analyticsStatus === 'indexing' || analyticsStatus === 'partial',
    backfillComplete: params.indexerState?.backfillComplete ?? false,
    oldestIndexedAt,
    newestIndexedAt,
    lastRunStatus: params.indexerState?.lastRunStatus ?? 'idle',
    lastRunError: params.indexerState?.lastRunError ?? null,
    lastRunWarningsCount: params.indexerState?.lastRunWarningsCount ?? 0,
    lastSuccessfulRunAt: params.indexerState?.lastSuccessfulRunAt ?? null,
  };
}

export function buildKpis(
  currentRows: readonly DashboardTransactionRow[],
  previousRows: readonly DashboardTransactionRow[],
): DashboardKpis {
  const current = summarizeRows(currentRows);
  const previous = summarizeRows(previousRows);
  return {
    totalTransactions: kpi(current.totalTransactions, previous.totalTransactions),
    uniqueWallets: kpi(current.uniqueWallets, previous.uniqueWallets),
    totalFeesLamports: kpi(current.totalFeesLamports, previous.totalFeesLamports),
    successRate: kpi(current.successRate, previous.successRate),
  };
}

export function buildSeries(
  rows: readonly DashboardTransactionRow[],
  window: DashboardWindow,
  now = Date.now(),
): SeriesPoint[] {
  const range = buildSeriesRange(rows, window, now);
  const { bucketCount, start, duration } = range;
  const bucketMs = duration / bucketCount;
  const buckets = Array.from({ length: bucketCount }, (_, index) => ({
    bucket: new Date(start + index * bucketMs).toISOString(),
    txCount: 0,
    wallets: new Set<string>(),
    feesLamports: 0n,
    feeEventCount: 0,
  }));

  for (const row of rows) {
    const time = new Date(row.block_time).getTime();
    const index = Math.min(
      bucketCount - 1,
      Math.max(0, Math.floor((time - start) / bucketMs)),
    );
    const bucket = buckets[index];
    bucket.txCount += 1;
    bucket.wallets.add(row.wallet_pda);
    const feeLamports = BigInt(row.protocol_fee_lamports);
    if (row.status === 'success' && feeLamports > 0n) {
      bucket.feesLamports += feeLamports;
      bucket.feeEventCount += 1;
    }
  }

  return buckets.map((bucket) => ({
    bucket: bucket.bucket,
    txCount: bucket.txCount,
    uniqueWallets: bucket.wallets.size,
    feesLamports: bucket.feesLamports.toString(),
    feeEventCount: bucket.feeEventCount,
  }));
}

function buildSeriesRange(
  rows: readonly DashboardTransactionRow[],
  window: DashboardWindow,
  now: number,
): { bucketCount: number; start: number; duration: number } {
  if (window !== 'all') {
    const duration = windowToMs(window);
    return {
      bucketCount: window === '24h' ? 24 : window === '7d' ? 7 : 30,
      start: now - duration,
      duration,
    };
  }

  const bucketCount = 30;
  if (rows.length === 0) {
    const duration = windowToMs('30d');
    return { bucketCount, start: now - duration, duration };
  }

  const rowTimes = rows
    .map((row) => new Date(row.block_time).getTime())
    .filter(Number.isFinite);
  if (rowTimes.length === 0) {
    const duration = windowToMs('30d');
    return { bucketCount, start: now - duration, duration };
  }
  const firstRowTime = Math.min(...rowTimes);
  const lastRowTime = Math.max(...rowTimes, now);
  const fallbackDuration = windowToMs('30d');
  const duration = Math.max(lastRowTime - firstRowTime, fallbackDuration);

  return {
    bucketCount,
    start: lastRowTime - duration,
    duration,
  };
}

export function buildNetworkComparison(
  rows: readonly DashboardTransactionRow[],
): NetworkComparison {
  return rows.reduce<NetworkComparison>(
    (acc, row) => {
      if (row.cluster === 'mainnet') acc.mainnetTxCount += 1;
      if (row.cluster === 'devnet') acc.devnetTxCount += 1;
      return acc;
    },
    { mainnetTxCount: 0, devnetTxCount: 0 },
  );
}

function summarizeRows(rows: readonly DashboardTransactionRow[]) {
  const successful = rows.filter((row) => row.status === 'success');
  const totalFeesLamports = successful.reduce(
    (sum, row) => sum + BigInt(row.protocol_fee_lamports),
    0n,
  );
  return {
    totalTransactions: rows.length,
    uniqueWallets: new Set(rows.map((row) => row.wallet_pda)).size,
    totalFeesLamports: totalFeesLamports.toString(),
    successRate: rows.length === 0 ? 0 : successful.length / rows.length,
  };
}

function kpi(
  value: number | string,
  previousValue: number | string,
): KpiValue {
  const current = Number(value);
  const previous = Number(previousValue);
  return {
    value,
    previousValue,
    percentChange:
      previous === 0
        ? current === 0
          ? 0
          : null
        : ((current - previous) / previous) * 100,
  };
}

function toLatestTransaction(row: DashboardTransactionRow): LatestTransaction {
  return {
    signature: row.signature,
    blockTime: row.block_time,
    slot: row.slot,
    feePayer: row.fee_payer,
    walletPda: row.wallet_pda,
    method: row.method,
    status: row.status,
    feeLamports: row.protocol_fee_lamports,
  };
}

function emptyDashboardStats(
  cluster: ClusterId,
  window: DashboardWindow,
  now: number,
  setupRequired: boolean,
  protocolStatus: DashboardStats['health']['protocolStatus'] = 'not-initialized',
  protocolStats: ProtocolStats | null = null,
  pagination: DashboardPaginationOptions = {
    txPage: DEFAULT_TX_PAGE,
    txLimit: DEFAULT_TX_LIMIT,
  },
): DashboardStats {
  const cursor: IndexerCursorRow | null = null;
  return {
    cluster,
    window,
    generatedAt: new Date(now).toISOString(),
    setupRequired,
    protocolStats,
    health: {
      protocolStatus,
      ...buildAnalyticsHealth({
        setupRequired,
        indexerState: null,
        oldestIndexed: null,
        newestIndexed: null,
        now,
      }),
      lastIndexedSlot: cursor?.last_indexed_slot ?? null,
      lastIndexedAt: cursor?.last_indexed_at ?? null,
      cacheHit: false,
      cacheTtlSeconds: DASHBOARD_CACHE_TTL_SECONDS,
    },
    kpis: buildKpis([], []),
    series: buildSeries([], window, now),
    latestTransactions: [],
    latestTransactionsPagination: buildPagination(
      pagination.txPage,
      pagination.txLimit,
      0,
    ),
    networkComparison: { mainnetTxCount: 0, devnetTxCount: 0 },
  };
}

function formatCoverageDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(value));
}

function parseOptionalPositiveInteger(value: unknown, fallback: number): number | null {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') return null;
  if (!/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
