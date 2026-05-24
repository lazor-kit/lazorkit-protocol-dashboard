import { getSupabaseConfig } from './env.js';
import type {
  DashboardStats,
  IndexerRunStatus,
  LazorKitMethod,
  TransactionStatus,
} from '../../src/solana/dashboardTypes.js';
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
  }): Promise<DashboardStats | null> {
    const existing = await this.getProtocolSnapshot(params.cluster);
    const entry = existing?.snapshot.dashboard?.[params.cacheKey];
    if (!entry) return null;

    const expiresAt = new Date(entry.expiresAt).getTime();
    if (!Number.isFinite(expiresAt) || expiresAt <= params.nowMs) return null;

    return {
      ...entry.stats,
      health: {
        ...entry.stats.health,
        cacheHit: true,
        cacheTtlSeconds: Math.max(
          1,
          Math.ceil((expiresAt - params.nowMs) / 1000),
        ),
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
