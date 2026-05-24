import type {
  DashboardKpis,
  DashboardStats,
  DashboardWindow,
  KpiValue,
  LatestTransaction,
  LatestTransactionsPagination,
  NetworkComparison,
  SeriesPoint,
} from '../../src/solana/dashboardTypes';
import type { ProtocolStats } from '../../src/solana/protocolStatsTypes';
import { isDashboardWindow } from '../../src/solana/dashboardTypes';
import { type ClusterId } from '../../src/solana/shared';
import {
  SupabaseNotConfiguredError,
  SupabaseRestClient,
  type DashboardTransactionRow,
  type IndexerCursorRow,
} from './database';
import { getCachedProtocolStats } from './protocolStats';

export const DASHBOARD_CACHE_TTL_SECONDS = 30;
export const DEFAULT_TX_PAGE = 1;
export const DEFAULT_TX_LIMIT = 10;
export const ALLOWED_TX_LIMITS = [10, 15] as const;
const ALL_TIME_START_ISO = '1970-01-01T00:00:00.000Z';

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

  const stats = await buildDashboardStats(cluster, window, now, pagination);
  dashboardCache.set(cacheKey, {
    stats,
    expiresAt: now + DASHBOARD_CACHE_TTL_SECONDS * 1000,
  });
  return stats;
}

async function buildDashboardStats(
  cluster: ClusterId,
  window: DashboardWindow,
  now: number,
  pagination: DashboardPaginationOptions,
): Promise<DashboardStats> {
  let db: SupabaseRestClient;
  try {
    db = new SupabaseRestClient();
  } catch (error) {
    if (error instanceof SupabaseNotConfiguredError) {
      const protocolStats =
        process.env.NODE_ENV === 'test'
          ? null
          : await getCachedProtocolStats(cluster).catch(() => null);
      return emptyDashboardStats(
        cluster,
        window,
        now,
        true,
        protocolStats
          ? protocolStats.initialized === false
            ? 'not-initialized'
            : protocolStats.config?.enabled
              ? 'enabled'
              : 'paused'
          : 'not-initialized',
        protocolStats,
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
  const [rows, latestTransactionsResult, cursor, protocolStats] = await Promise.all([
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
    getCachedProtocolStats(cluster).catch(() => null),
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
    protocolStats?.initialized === false
      ? 'not-initialized'
      : protocolStats?.config?.enabled
        ? 'enabled'
        : 'paused';

  return {
    cluster,
    window,
    generatedAt: new Date(now).toISOString(),
    setupRequired: false,
    protocolStats,
    health: {
      protocolStatus,
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
    if (row.status === 'success') {
      bucket.feesLamports += BigInt(row.protocol_fee_lamports);
    }
  }

  return buckets.map((bucket) => ({
    bucket: bucket.bucket,
    txCount: bucket.txCount,
    uniqueWallets: bucket.wallets.size,
    feesLamports: bucket.feesLamports.toString(),
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

function parseOptionalPositiveInteger(value: unknown, fallback: number): number | null {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') return null;
  if (!/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
