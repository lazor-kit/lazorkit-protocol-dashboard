import { isClusterId, type ClusterId } from './shared';
import type { ProtocolStats } from './protocolStatsTypes';
export type {
  AggregatedFeeRecords,
  FeeRecordRow,
  ProtocolStats,
  ShardRow,
} from './protocolStatsTypes';

export async function fetchProtocolStats(
  cluster: ClusterId,
): Promise<ProtocolStats> {
  const response = await fetch(`/api/protocol-stats?cluster=${cluster}`, {
    headers: { accept: 'application/json' },
  });

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      typeof payload === 'object' &&
      payload !== null &&
      'error' in payload &&
      typeof payload.error === 'string'
        ? payload.error
        : `Unable to load protocol stats (${response.status})`;
    throw new Error(message);
  }

  if (!isProtocolStats(payload)) {
    throw new Error('Protocol stats API returned an invalid response');
  }

  return payload;
}

function isProtocolStats(value: unknown): value is ProtocolStats {
  if (typeof value !== 'object' || value === null) return false;
  const stats = value as Partial<ProtocolStats>;
  return (
    isClusterId(stats.cluster) &&
    typeof stats.programId === 'string' &&
    typeof stats.protocolConfigAddress === 'string' &&
    typeof stats.slot === 'number' &&
    typeof stats.fetchedAt === 'string' &&
    typeof stats.initialized === 'boolean' &&
    Array.isArray(stats.feeRecords) &&
    Array.isArray(stats.shards)
  );
}
