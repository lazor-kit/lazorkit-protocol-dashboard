import { getSupabaseConfig } from './env';
import type {
  LazorKitMethod,
  TransactionStatus,
} from '../../src/solana/dashboardTypes';
import { type ClusterId } from '../../src/solana/shared';

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

export interface PaginatedDashboardTransactions {
  rows: DashboardTransactionRow[];
  total: number;
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
