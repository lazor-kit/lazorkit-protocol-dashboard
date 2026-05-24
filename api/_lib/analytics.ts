import type {
  DashboardKpis,
  DashboardStats,
  DashboardWindow,
  KpiValue,
  LatestTransaction,
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

interface DashboardCacheEntry {
  expiresAt: number;
  stats: DashboardStats;
}

const dashboardCache = new Map<string, DashboardCacheEntry>();

export function parseDashboardWindow(value: unknown): DashboardWindow {
  return isDashboardWindow(value) ? value : '24h';
}

export function windowToMs(window: DashboardWindow): number {
  if (window === '24h') return 24 * 60 * 60 * 1000;
  if (window === '7d') return 7 * 24 * 60 * 60 * 1000;
  return 30 * 24 * 60 * 60 * 1000;
}

export async function getDashboardStats(
  cluster: ClusterId,
  window: DashboardWindow,
): Promise<DashboardStats> {
  const now = Date.now();
  const cacheKey = `${cluster}:${window}`;
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

  const stats = await buildDashboardStats(cluster, window, now);
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
      );
    }
    throw error;
  }

  const duration = windowToMs(window);
  const currentStart = new Date(now - duration).toISOString();
  const previousStart = new Date(now - duration * 2).toISOString();
  const currentEnd = new Date(now).toISOString();

  const [rows, cursor, protocolStats] = await Promise.all([
    db.selectDashboardTransactions({
      clusters: ['mainnet', 'devnet'],
      sinceIso: previousStart,
      untilIso: currentEnd,
      order: 'desc',
      limit: 20000,
    }),
    db.getCursor(cluster),
    getCachedProtocolStats(cluster).catch(() => null),
  ]);

  const selectedRows = rows.filter((row) => row.cluster === cluster);
  const currentRows = selectedRows.filter((row) => row.block_time >= currentStart);
  const previousRows = rows.filter(
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
    latestTransactions: currentRows.slice(0, 20).map(toLatestTransaction),
    networkComparison: buildNetworkComparison(comparisonRows),
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
  const duration = windowToMs(window);
  const bucketCount = window === '24h' ? 24 : window === '7d' ? 7 : 30;
  const bucketMs = duration / bucketCount;
  const start = now - duration;
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
    networkComparison: { mainnetTxCount: 0, devnetTxCount: 0 },
  };
}
