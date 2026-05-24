import { getSupabaseConfig } from './env.js';
import type {
  DashboardStats,
  IndexerRunStatus,
  LazorKitMethod,
  TransactionStatus,
} from '../../src/solana/dashboardTypes.js';
import type { ProtocolStats } from '../../src/solana/protocolStatsTypes.js';
import { type ClusterId } from '../../src/solana/shared.js';

export interface ProtocolTransactionRow {
  cluster: ClusterId;
  signature: string;
  slot: number;
  block_time: string;
  fee_payer: string;
  wallet_pda: string;
  method: LazorKitMethod;
  status: TransactionStatus;
  protocol_fee_lamports: string;
  treasury_shard: string | null;
  fee_record: string | null;
  instruction_index: number;
  parse_warnings: string[];
}

export type BucketGranularity = 'hour' | 'day';

export interface ProtocolMetricBucketRow {
  cluster: ClusterId;
  bucket_start: string;
  bucket_granularity: BucketGranularity;
  tx_count: number;
  success_count: number;
  failed_count: number;
  fee_lamports: string;
  create_wallet_count: number;
  execute_count: number;
  execute_deferred_count: number;
}

export interface LatestProtocolTransactionRow {
  cluster: ClusterId;
  signature: string;
  slot: number;
  block_time: string;
  fee_payer: string;
  wallet_pda: string;
  method: LazorKitMethod;
  status: TransactionStatus;
  fee_lamports: string;
}

export interface ProtocolStateSnapshotRow {
  cluster: ClusterId;
  protocol_status: 'enabled' | 'paused' | 'not-initialized';
  wallet_account_count: number;
  fee_record_count: number;
  wallets_recorded: number;
  txns_recorded: number;
  fee_paying_events: number;
  lifetime_fees_lamports: string;
  collectible_fees_lamports: string;
  shard_balances_lamports: string;
  snapshot_json: ProtocolStats;
  updated_at?: string;
}

export type DashboardTransactionRow = Pick<
  ProtocolTransactionRow,
  | 'cluster'
  | 'signature'
  | 'slot'
  | 'block_time'
  | 'fee_payer'
  | 'wallet_pda'
  | 'method'
  | 'status'
  | 'protocol_fee_lamports'
>;

export interface IndexerCursorRow {
  cluster: ClusterId;
  last_seen_signature: string | null;
  last_indexed_slot: number | null;
  last_indexed_at: string | null;
  updated_at?: string;
}

export interface IndexerState {
  lastRunStartedAt: string | null;
  lastRunCompletedAt: string | null;
  lastRunStatus: IndexerRunStatus;
  lastRunError: string | null;
  lastRunWarningsCount: number;
  newestIndexedAt: string | null;
  oldestIndexedAt: string | null;
  backfillStartedAt: string | null;
  backfillCompletedAt: string | null;
  backfillBeforeSignature: string | null;
  backfillComplete: boolean;
  backfillDays: number;
  backfillUpdatedAt: string | null;
  lastSuccessfulRunAt: string | null;
}

interface ProtocolSnapshotRow {
  cluster: ClusterId;
  snapshot: {
    indexer?: Partial<IndexerState>;
    dashboard?: Record<string, DashboardSnapshotEntry>;
    protocolStats?: ProtocolStats;
    [key: string]: unknown;
  };
  fetched_at: string;
}

interface DashboardSnapshotEntry {
  cachedAt: string;
  expiresAt: string;
  stats: DashboardStats;
}

export interface PaginatedDashboardTransactions {
  rows: DashboardTransactionRow[];
  total: number;
}

export interface PaginatedLatestProtocolTransactions {
  rows: LatestProtocolTransactionRow[];
  total: number;
}

export interface IndexedTransactionBoundary {
  signature: string;
  block_time: string;
}

type SupabaseConfig = Extract<ReturnType<typeof getSupabaseConfig>, { configured: true }>;

export class SupabaseNotConfiguredError extends Error {
  constructor() {
    super('Supabase is not configured');
  }
}

export class SupabaseRestClient {
  private readonly config: SupabaseConfig;

  constructor(config = getSupabaseConfig()) {
    if (!config.configured) throw new SupabaseNotConfiguredError();
    this.config = config;
  }

  async selectProtocolTransactions(params: {
    clusters?: ClusterId[];
    cluster?: ClusterId;
    sinceIso: string;
    untilIso?: string;
    limit?: number;
    offset?: number;
    order?: 'asc' | 'desc';
  }): Promise<ProtocolTransactionRow[]> {
    const search = new URLSearchParams();
    search.set('select', '*');
    search.set('block_time', `gte.${params.sinceIso}`);
    if (params.untilIso) search.append('block_time', `lt.${params.untilIso}`);
    if (params.cluster) search.set('cluster', `eq.${params.cluster}`);
    if (params.clusters) {
      search.set('cluster', `in.(${params.clusters.join(',')})`);
    }
    search.set('order', `block_time.${params.order ?? 'desc'}`);
    search.set('limit', String(params.limit ?? 5000));
    if (params.offset) search.set('offset', String(params.offset));
    return this.request<ProtocolTransactionRow[]>(
      `/rest/v1/protocol_transactions?${search.toString()}`,
    );
  }

  async selectDashboardTransactions(params: {
    clusters: ClusterId[];
    sinceIso: string;
    untilIso: string;
    limit?: number;
    order?: 'asc' | 'desc';
  }): Promise<DashboardTransactionRow[]> {
    const search = new URLSearchParams();
    search.set(
      'select',
      [
        'cluster',
        'signature',
        'slot',
        'block_time',
        'fee_payer',
        'wallet_pda',
        'method',
        'status',
        'protocol_fee_lamports',
      ].join(','),
    );
    search.set('cluster', `in.(${params.clusters.join(',')})`);
    search.set('block_time', `gte.${params.sinceIso}`);
    search.append('block_time', `lt.${params.untilIso}`);
    search.set('order', `block_time.${params.order ?? 'desc'}`);
    search.set('limit', String(params.limit ?? 20000));
    return this.request<DashboardTransactionRow[]>(
      `/rest/v1/protocol_transactions?${search.toString()}`,
    );
  }

  async selectLatestDashboardTransactions(params: {
    cluster: ClusterId;
    sinceIso: string;
    untilIso: string;
    limit: number;
    offset: number;
  }): Promise<PaginatedDashboardTransactions> {
    const search = new URLSearchParams();
    search.set(
      'select',
      [
        'cluster',
        'signature',
        'slot',
        'block_time',
        'fee_payer',
        'wallet_pda',
        'method',
        'status',
        'protocol_fee_lamports',
      ].join(','),
    );
    search.set('cluster', `eq.${params.cluster}`);
    search.set('block_time', `gte.${params.sinceIso}`);
    search.append('block_time', `lt.${params.untilIso}`);
    search.set('order', 'block_time.desc');
    search.set('limit', String(params.limit));
    search.set('offset', String(params.offset));

    const response = await this.requestWithHeaders<DashboardTransactionRow[]>(
      `/rest/v1/protocol_transactions?${search.toString()}`,
      { headers: { prefer: 'count=exact' } },
    );
    return {
      rows: response.body,
      total: parseContentRangeTotal(response.headers.get('content-range')),
    };
  }

  async getOldestIndexedTransaction(
    cluster: ClusterId,
  ): Promise<IndexedTransactionBoundary | null> {
    const search = new URLSearchParams();
    search.set('select', 'signature,block_time');
    search.set('cluster', `eq.${cluster}`);
    search.set('order', 'block_time.asc');
    search.set('limit', '1');

    const rows = await this.request<IndexedTransactionBoundary[]>(
      `/rest/v1/protocol_transactions?${search.toString()}`,
    );
    return rows[0] ?? null;
  }

  async getNewestIndexedTransaction(
    cluster: ClusterId,
  ): Promise<IndexedTransactionBoundary | null> {
    const search = new URLSearchParams();
    search.set('select', 'signature,block_time');
    search.set('cluster', `eq.${cluster}`);
    search.set('order', 'block_time.desc');
    search.set('limit', '1');

    const rows = await this.request<IndexedTransactionBoundary[]>(
      `/rest/v1/protocol_transactions?${search.toString()}`,
    );
    return rows[0] ?? null;
  }

  async upsertProtocolTransactions(rows: ProtocolTransactionRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.request('/rest/v1/protocol_transactions?on_conflict=cluster,signature', {
      method: 'POST',
      headers: { prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify(rows),
    });
  }

  async selectMetricBuckets(params: {
    clusters?: ClusterId[];
    cluster?: ClusterId;
    granularity?: BucketGranularity;
    sinceIso?: string;
    untilIso?: string;
    order?: 'asc' | 'desc';
    limit?: number;
  }): Promise<ProtocolMetricBucketRow[]> {
    const search = new URLSearchParams();
    search.set('select', '*');
    if (params.cluster) search.set('cluster', `eq.${params.cluster}`);
    if (params.clusters) {
      search.set('cluster', `in.(${params.clusters.join(',')})`);
    }
    if (params.granularity) {
      search.set('bucket_granularity', `eq.${params.granularity}`);
    }
    if (params.sinceIso) search.set('bucket_start', `gte.${params.sinceIso}`);
    if (params.untilIso) search.append('bucket_start', `lt.${params.untilIso}`);
    search.set('order', `bucket_start.${params.order ?? 'asc'}`);
    if (params.limit) search.set('limit', String(params.limit));

    return this.request<ProtocolMetricBucketRow[]>(
      `/rest/v1/protocol_metric_buckets?${search.toString()}`,
    );
  }

  async getMetricBoundaries(cluster: ClusterId): Promise<{
    oldest: IndexedTransactionBoundary | null;
    newest: IndexedTransactionBoundary | null;
  }> {
    const oldestSearch = new URLSearchParams({
      select: 'bucket_start',
      cluster: `eq.${cluster}`,
      order: 'bucket_start.asc',
      limit: '1',
    });
    const newestSearch = new URLSearchParams({
      select: 'bucket_start',
      cluster: `eq.${cluster}`,
      order: 'bucket_start.desc',
      limit: '1',
    });
    const [oldestRows, newestRows] = await Promise.all([
      this.request<Array<{ bucket_start: string }>>(
        `/rest/v1/protocol_metric_buckets?${oldestSearch.toString()}`,
      ),
      this.request<Array<{ bucket_start: string }>>(
        `/rest/v1/protocol_metric_buckets?${newestSearch.toString()}`,
      ),
    ]);

    return {
      oldest: oldestRows[0]
        ? { signature: '', block_time: oldestRows[0].bucket_start }
        : null,
      newest: newestRows[0]
        ? { signature: '', block_time: newestRows[0].bucket_start }
        : null,
    };
  }

  async upsertMetricBuckets(rows: ProtocolMetricBucketRow[]): Promise<void> {
    if (rows.length === 0) return;
    const mergedRows = await this.mergeExistingMetricBuckets(rows);
    await this.request(
      '/rest/v1/protocol_metric_buckets?on_conflict=cluster,bucket_granularity,bucket_start',
      {
        method: 'POST',
        headers: { prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify(mergedRows),
      },
    );
  }

  async upsertLatestProtocolTransactions(
    rows: LatestProtocolTransactionRow[],
  ): Promise<void> {
    if (rows.length === 0) return;
    await this.request(
      '/rest/v1/latest_protocol_transactions?on_conflict=cluster,signature',
      {
        method: 'POST',
        headers: { prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify(rows),
      },
    );
  }

  async selectLatestProtocolTransactions(params: {
    cluster: ClusterId;
    limit: number;
    offset: number;
  }): Promise<PaginatedLatestProtocolTransactions> {
    const search = new URLSearchParams();
    search.set('select', '*');
    search.set('cluster', `eq.${params.cluster}`);
    search.set('order', 'block_time.desc');
    search.set('limit', String(params.limit));
    search.set('offset', String(params.offset));

    const response = await this.requestWithHeaders<LatestProtocolTransactionRow[]>(
      `/rest/v1/latest_protocol_transactions?${search.toString()}`,
      { headers: { prefer: 'count=exact' } },
    );
    return {
      rows: response.body,
      total: parseContentRangeTotal(response.headers.get('content-range')),
    };
  }

  async pruneLatestProtocolTransactions(
    cluster: ClusterId,
    keepCount: number,
  ): Promise<void> {
    const search = new URLSearchParams();
    search.set('select', 'signature');
    search.set('cluster', `eq.${cluster}`);
    search.set('order', 'block_time.desc');
    search.set('offset', String(keepCount));
    search.set('limit', '1000');
    const staleRows = await this.request<Array<{ signature: string }>>(
      `/rest/v1/latest_protocol_transactions?${search.toString()}`,
    );
    if (staleRows.length === 0) return;
    const signatures = staleRows.map((row) => row.signature).join(',');
    await this.request(
      `/rest/v1/latest_protocol_transactions?cluster=eq.${cluster}&signature=in.(${signatures})`,
      { method: 'DELETE' },
    );
  }

  async getProtocolStateSnapshot(
    cluster: ClusterId,
  ): Promise<ProtocolStateSnapshotRow | null> {
    const search = new URLSearchParams({
      select: '*',
      cluster: `eq.${cluster}`,
      limit: '1',
    });
    const rows = await this.request<ProtocolStateSnapshotRow[]>(
      `/rest/v1/protocol_state_snapshots?${search.toString()}`,
    );
    return rows[0] ?? null;
  }

  async upsertProtocolStateSnapshot(
    row: ProtocolStateSnapshotRow,
  ): Promise<void> {
    await this.request('/rest/v1/protocol_state_snapshots?on_conflict=cluster', {
      method: 'POST',
      headers: { prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify([row]),
    });
  }

  async clearAggregateAnalytics(): Promise<void> {
    await Promise.all([
      this.request('/rest/v1/protocol_metric_buckets?cluster=not.is.null', {
        method: 'DELETE',
      }),
      this.request('/rest/v1/latest_protocol_transactions?cluster=not.is.null', {
        method: 'DELETE',
      }),
      this.request('/rest/v1/protocol_state_snapshots?cluster=not.is.null', {
        method: 'DELETE',
      }),
    ]);
  }

  async getCursor(cluster: ClusterId): Promise<IndexerCursorRow | null> {
    const search = new URLSearchParams({
      select: '*',
      cluster: `eq.${cluster}`,
      limit: '1',
    });
    const rows = await this.request<IndexerCursorRow[]>(
      `/rest/v1/indexer_cursors?${search.toString()}`,
    );
    return rows[0] ?? null;
  }

  async upsertCursor(row: IndexerCursorRow): Promise<void> {
    await this.request('/rest/v1/indexer_cursors?on_conflict=cluster', {
      method: 'POST',
      headers: { prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify([row]),
    });
  }

  async getIndexerState(cluster: ClusterId): Promise<IndexerState | null> {
    const search = new URLSearchParams({
      select: 'snapshot',
      cluster: `eq.${cluster}`,
      limit: '1',
    });
    const rows = await this.request<Array<Pick<ProtocolSnapshotRow, 'snapshot'>>>(
      `/rest/v1/protocol_snapshots?${search.toString()}`,
    );
    const indexer = rows[0]?.snapshot.indexer;
    if (!indexer) return null;
    return {
      lastRunStartedAt: readNullableString(indexer.lastRunStartedAt),
      lastRunCompletedAt: readNullableString(indexer.lastRunCompletedAt),
      lastRunStatus: readRunStatus(indexer.lastRunStatus),
      lastRunError: readNullableString(indexer.lastRunError),
      lastRunWarningsCount: readNumber(indexer.lastRunWarningsCount, 0),
      newestIndexedAt: readNullableString(indexer.newestIndexedAt),
      oldestIndexedAt: readNullableString(indexer.oldestIndexedAt),
      backfillStartedAt: readNullableString(indexer.backfillStartedAt),
      backfillCompletedAt: readNullableString(indexer.backfillCompletedAt),
      backfillBeforeSignature: readNullableString(indexer.backfillBeforeSignature),
      backfillComplete: indexer.backfillComplete === true,
      backfillDays: readNumber(indexer.backfillDays, 0),
      backfillUpdatedAt: readNullableString(indexer.backfillUpdatedAt),
      lastSuccessfulRunAt: readNullableString(indexer.lastSuccessfulRunAt),
    };
  }

  async upsertIndexerState(cluster: ClusterId, state: IndexerState): Promise<void> {
    const existing = await this.getProtocolSnapshot(cluster);
    const now = new Date().toISOString();
    await this.request('/rest/v1/protocol_snapshots?on_conflict=cluster', {
      method: 'POST',
      headers: { prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify([
        {
          cluster,
          snapshot: {
            ...(existing?.snapshot ?? {}),
            indexer: state,
          },
          fetched_at: existing?.fetched_at ?? now,
        },
      ]),
    });
  }

  async getDashboardSnapshot(params: {
    cluster: ClusterId;
    cacheKey: string;
    nowMs: number;
    allowStale?: boolean;
  }): Promise<DashboardStats | null> {
    const existing = await this.getProtocolSnapshot(params.cluster);
    const entry = existing?.snapshot.dashboard?.[params.cacheKey];
    if (!entry) return null;

    const expiresAt = new Date(entry.expiresAt).getTime();
    if (
      !params.allowStale &&
      (!Number.isFinite(expiresAt) || expiresAt <= params.nowMs)
    ) {
      return null;
    }

    return {
      ...entry.stats,
      health: {
        ...entry.stats.health,
        cacheHit: true,
        cacheTtlSeconds:
          Number.isFinite(expiresAt) && expiresAt > params.nowMs
            ? Math.max(1, Math.ceil((expiresAt - params.nowMs) / 1000))
            : 0,
      },
    };
  }

  async upsertDashboardSnapshot(params: {
    cluster: ClusterId;
    cacheKey: string;
    stats: DashboardStats;
    ttlSeconds: number;
  }): Promise<void> {
    const existing = await this.getProtocolSnapshot(params.cluster);
    const nowMs = Date.now();
    const cachedAt = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + params.ttlSeconds * 1000).toISOString();
    const dashboard = {
      ...(existing?.snapshot.dashboard ?? {}),
      [params.cacheKey]: {
        cachedAt,
        expiresAt,
        stats: params.stats,
      },
    };

    await this.request('/rest/v1/protocol_snapshots?on_conflict=cluster', {
      method: 'POST',
      headers: { prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify([
        {
          cluster: params.cluster,
          snapshot: {
            ...(existing?.snapshot ?? {}),
            dashboard,
          },
          fetched_at: existing?.fetched_at ?? cachedAt,
        },
      ]),
    });
  }

  async getProtocolStatsSnapshot(cluster: ClusterId): Promise<ProtocolStats | null> {
    const stateSnapshot = await this.getProtocolStateSnapshot(cluster);
    if (stateSnapshot?.snapshot_json) {
      return {
        ...stateSnapshot.snapshot_json,
        cache: {
          hit: true,
          ttlSeconds: 300,
        },
      };
    }

    const existing = await this.getProtocolSnapshot(cluster);
    const protocolStats = existing?.snapshot.protocolStats;
    if (!isProtocolStatsSnapshot(protocolStats, cluster)) return null;
    return {
      ...protocolStats,
      cache: {
        hit: true,
        ttlSeconds: 30,
      },
    };
  }

  async upsertProtocolStatsSnapshot(
    cluster: ClusterId,
    protocolStats: ProtocolStats,
  ): Promise<void> {
    await this.upsertProtocolStateSnapshot(toProtocolStateSnapshotRow(protocolStats));

    const existing = await this.getProtocolSnapshot(cluster);
    const now = new Date().toISOString();
    await this.request('/rest/v1/protocol_snapshots?on_conflict=cluster', {
      method: 'POST',
      headers: { prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify([
        {
          cluster,
          snapshot: {
            ...(existing?.snapshot ?? {}),
            protocolStats,
          },
          fetched_at: protocolStats.fetchedAt || now,
        },
      ]),
    });
  }

  private async getProtocolSnapshot(
    cluster: ClusterId,
  ): Promise<ProtocolSnapshotRow | null> {
    const search = new URLSearchParams({
      select: 'cluster,snapshot,fetched_at',
      cluster: `eq.${cluster}`,
      limit: '1',
    });
    const rows = await this.request<ProtocolSnapshotRow[]>(
      `/rest/v1/protocol_snapshots?${search.toString()}`,
    );
    return rows[0] ?? null;
  }

  private async mergeExistingMetricBuckets(
    rows: ProtocolMetricBucketRow[],
  ): Promise<ProtocolMetricBucketRow[]> {
    const byKey = new Map<string, ProtocolMetricBucketRow>();
    for (const row of rows) {
      const key = metricBucketKey(row);
      const existing = byKey.get(key);
      byKey.set(key, existing ? addMetricBuckets(existing, row) : row);
    }

    const mergedRows = [...byKey.values()];
    const groups = new Map<string, ProtocolMetricBucketRow[]>();
    for (const row of mergedRows) {
      const key = `${row.cluster}:${row.bucket_granularity}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }

    const existingRows: ProtocolMetricBucketRow[] = [];
    for (const groupRows of groups.values()) {
      const first = groupRows[0];
      const times = groupRows.map((row) => new Date(row.bucket_start).getTime());
      const min = Math.min(...times);
      const max = Math.max(...times);
      existingRows.push(
        ...(await this.selectMetricBuckets({
          cluster: first.cluster,
          granularity: first.bucket_granularity,
          sinceIso: new Date(min).toISOString(),
          untilIso: new Date(max + 1).toISOString(),
        })),
      );
    }

    const existingByKey = new Map(
      existingRows.map((row) => [metricBucketKey(row), row]),
    );
    return mergedRows.map((row) => {
      const existing = existingByKey.get(metricBucketKey(row));
      return existing ? addMetricBuckets(existing, row) : row;
    });
  }

  private async request<T = unknown>(
    path: string,
    init: RequestInit & { headers?: Record<string, string> } = {},
  ): Promise<T> {
    const response = await fetch(`${this.config.url}${path}`, {
      ...init,
      headers: {
        apikey: this.config.serviceRoleKey,
        authorization: `Bearer ${this.config.serviceRoleKey}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Supabase request failed ${response.status}: ${body}`);
    }

    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private async requestWithHeaders<T = unknown>(
    path: string,
    init: RequestInit & { headers?: Record<string, string> } = {},
  ): Promise<{ body: T; headers: Headers }> {
    const response = await fetch(`${this.config.url}${path}`, {
      ...init,
      headers: {
        apikey: this.config.serviceRoleKey,
        authorization: `Bearer ${this.config.serviceRoleKey}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Supabase request failed ${response.status}: ${body}`);
    }

    const text = await response.text();
    return {
      body: (text ? JSON.parse(text) : undefined) as T,
      headers: response.headers,
    };
  }
}

function parseContentRangeTotal(value: string | null): number {
  if (!value) return 0;
  const total = value.split('/')[1];
  if (!total || total === '*') return 0;
  const parsed = Number.parseInt(total, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readRunStatus(value: unknown): IndexerRunStatus {
  return value === 'running' ||
    value === 'success' ||
    value === 'partial' ||
    value === 'failed'
    ? value
    : 'idle';
}

function metricBucketKey(row: Pick<
  ProtocolMetricBucketRow,
  'cluster' | 'bucket_granularity' | 'bucket_start'
>): string {
  return `${row.cluster}:${row.bucket_granularity}:${new Date(
    row.bucket_start,
  ).toISOString()}`;
}

function addMetricBuckets(
  left: ProtocolMetricBucketRow,
  right: ProtocolMetricBucketRow,
): ProtocolMetricBucketRow {
  return {
    cluster: left.cluster,
    bucket_start: new Date(left.bucket_start).toISOString(),
    bucket_granularity: left.bucket_granularity,
    tx_count: left.tx_count + right.tx_count,
    success_count: left.success_count + right.success_count,
    failed_count: left.failed_count + right.failed_count,
    fee_lamports: (BigInt(left.fee_lamports) + BigInt(right.fee_lamports)).toString(),
    create_wallet_count: left.create_wallet_count + right.create_wallet_count,
    execute_count: left.execute_count + right.execute_count,
    execute_deferred_count:
      left.execute_deferred_count + right.execute_deferred_count,
  };
}

function toProtocolStateSnapshotRow(
  stats: ProtocolStats,
): ProtocolStateSnapshotRow {
  const protocolStatus =
    !stats.initialized
      ? 'not-initialized'
      : stats.config?.enabled
        ? 'enabled'
        : 'paused';
  return {
    cluster: stats.cluster,
    protocol_status: protocolStatus,
    wallet_account_count: stats.walletAccountCount,
    fee_record_count: stats.feeTotals.recordCount,
    wallets_recorded: stats.feeTotals.walletCount,
    txns_recorded: stats.feeTotals.txCount,
    fee_paying_events: stats.feeTotals.feePayingEvents,
    lifetime_fees_lamports: stats.feeTotals.lifetimeFeesLamports,
    collectible_fees_lamports: stats.collectibleFeesLamports,
    shard_balances_lamports: stats.shardBalancesLamports,
    snapshot_json: stats,
  };
}

function isProtocolStatsSnapshot(
  value: unknown,
  cluster: ClusterId,
): value is ProtocolStats {
  if (typeof value !== 'object' || value === null) return false;
  const stats = value as Partial<ProtocolStats>;
  return (
    stats.cluster === cluster &&
    typeof stats.programId === 'string' &&
    typeof stats.protocolConfigAddress === 'string' &&
    typeof stats.slot === 'number' &&
    typeof stats.fetchedAt === 'string' &&
    typeof stats.initialized === 'boolean' &&
    Array.isArray(stats.feeRecords) &&
    Array.isArray(stats.shards) &&
    typeof stats.walletAccountCount === 'number' &&
    typeof stats.collectibleFeesLamports === 'string' &&
    typeof stats.shardBalancesLamports === 'string'
  );
}
