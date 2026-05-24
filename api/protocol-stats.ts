import { SupabaseNotConfiguredError, SupabaseRestClient } from './_lib/database.js';
import type { ProtocolStats } from '../src/solana/protocolStatsTypes.js';

interface ApiRequest {
  method?: string;
  query: Record<string, string | string[] | undefined>;
}

interface ApiResponse {
  setHeader(name: string, value: string): void;
  status(code: number): {
    json(body: unknown): void;
  };
}

const PROGRAM_ADDRESSES = {
  mainnet: 'LazorjRFNavitUaBu5m3WaNPjU1maipvSW2rZfAFAKi',
  devnet: '4h3XoNReAgEcHVxcZ8sw2aufi9MTr7BbvYYjzjWDyDxS',
  localnet: '4h3XoNReAgEcHVxcZ8sw2aufi9MTr7BbvYYjzjWDyDxS',
} as const;

type ApiClusterId = keyof typeof PROGRAM_ADDRESSES;

export default async function handler(
  request: ApiRequest,
  response: ApiResponse,
) {
  if (request.method !== 'GET') {
    response.setHeader('allow', 'GET');
    return response.status(405).json({ error: 'Method not allowed' });
  }

  const clusterParam = Array.isArray(request.query.cluster)
    ? request.query.cluster[0]
    : request.query.cluster;
  const cluster = clusterParam ?? 'mainnet';

  if (!isClusterId(cluster)) {
    return response.status(400).json({ error: 'Unsupported cluster' });
  }

  try {
    const db = new SupabaseRestClient();
    const stats = await db.getProtocolStatsSnapshot(cluster);
    response.setHeader('cache-control', 's-maxage=300, stale-while-revalidate=600');
    return response.status(200).json(stats ?? preparingProtocolStats(cluster));
  } catch (error) {
    if (error instanceof SupabaseNotConfiguredError) {
      return response.status(200).json(preparingProtocolStats(cluster));
    }
    const message =
      error instanceof Error ? error.message : 'Unable to fetch protocol stats';
    return response.status(502).json({ error: message });
  }
}

function isClusterId(value: unknown): value is ApiClusterId {
  return value === 'mainnet' || value === 'devnet' || value === 'localnet';
}

function preparingProtocolStats(cluster: ApiClusterId): ProtocolStats {
  const now = new Date().toISOString();
  return {
    cluster,
    programId: PROGRAM_ADDRESSES[cluster],
    protocolConfigAddress: '',
    slot: 0,
    fetchedAt: now,
    cache: {
      hit: false,
      ttlSeconds: 30,
    },
    initialized: false,
    config: null,
    walletAccountCount: 0,
    feeRecords: [],
    feeTotals: {
      recordCount: 0,
      lifetimeFeesLamports: '0',
      txCount: 0,
      walletCount: 0,
      feePayingEvents: 0,
    },
    shards: [],
    collectibleFeesLamports: '0',
    shardBalancesLamports: '0',
    skippedAccounts: 0,
  };
}
