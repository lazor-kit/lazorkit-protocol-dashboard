import type { ClusterId } from './shared.js';
import type { ProtocolStats } from './protocolStatsTypes.js';

export type DashboardWindow = 'all' | '24h' | '7d' | '30d';
export type LazorKitMethod = 'CreateWallet' | 'Execute' | 'ExecuteDeferred';
export type TransactionStatus = 'success' | 'failed';
export type AnalyticsStatus =
  | 'not_configured'
  | 'empty'
  | 'indexing'
  | 'partial'
  | 'fresh'
  | 'stale'
  | 'error';
export type IndexerRunStatus = 'idle' | 'running' | 'success' | 'partial' | 'failed';

export interface KpiValue {
  value: number | string;
  previousValue: number | string;
  percentChange: number | null;
}

export interface DashboardKpis {
  totalTransactions: KpiValue;
  uniqueWallets: KpiValue;
  totalFeesLamports: KpiValue;
  successRate: KpiValue;
}

export interface SeriesPoint {
  bucket: string;
  txCount: number;
  uniqueWallets: number;
  feesLamports: string;
  feeEventCount: number;
}

export interface LatestTransaction {
  signature: string;
  blockTime: string;
  slot: number;
  feePayer: string;
  walletPda: string;
  method: LazorKitMethod;
  status: TransactionStatus;
  feeLamports: string;
}

export interface NetworkComparison {
  mainnetTxCount: number;
  devnetTxCount: number;
}

export interface LatestTransactionsPagination {
  page: number;
  limit: 10 | 15;
  total: number;
  totalPages: number;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
}

export interface DashboardStats {
  cluster: ClusterId;
  window: DashboardWindow;
  generatedAt: string;
  setupRequired: boolean;
  protocolStats: ProtocolStats | null;
  health: {
    protocolStatus: 'enabled' | 'paused' | 'not-initialized';
    analyticsStatus: AnalyticsStatus;
    dataCoverageLabel: string;
    isBackfilling: boolean;
    backfillComplete: boolean;
    oldestIndexedAt: string | null;
    newestIndexedAt: string | null;
    lastRunStatus: IndexerRunStatus;
    lastRunError: string | null;
    lastRunWarningsCount: number;
    lastSuccessfulRunAt: string | null;
    lastIndexedSlot: number | null;
    lastIndexedAt: string | null;
    cacheHit: boolean;
    cacheTtlSeconds: number;
  };
  kpis: DashboardKpis;
  series: SeriesPoint[];
  latestTransactions: LatestTransaction[];
  latestTransactionsPagination: LatestTransactionsPagination;
  networkComparison: NetworkComparison;
}

export function isDashboardWindow(value: unknown): value is DashboardWindow {
  return value === 'all' || value === '24h' || value === '7d' || value === '30d';
}
