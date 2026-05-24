import {
  isDashboardWindow,
  type DashboardStats,
  type DashboardWindow,
} from './dashboardTypes.js';
import { isClusterId, type ClusterId } from './shared.js';

export async function fetchDashboardStats(
  cluster: ClusterId,
  window: DashboardWindow,
  txPage = 1,
  txLimit: 10 | 15 | 50 = 10,
): Promise<DashboardStats> {
  const params = new URLSearchParams({
    cluster,
    window,
    txPage: String(txPage),
    txLimit: String(txLimit),
  });
  const response = await fetch(`/api/dashboard?${params.toString()}`, {
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
        : `Unable to load dashboard (${response.status})`;
    throw new Error(message);
  }

  if (!isDashboardStats(payload)) {
    throw new Error('Dashboard API returned an invalid response');
  }

  return payload;
}

function isDashboardStats(value: unknown): value is DashboardStats {
  if (typeof value !== 'object' || value === null) return false;
  const stats = value as Partial<DashboardStats>;
  return (
    isClusterId(stats.cluster) &&
    isDashboardWindow(stats.window) &&
    typeof stats.generatedAt === 'string' &&
    typeof stats.setupRequired === 'boolean' &&
    (stats.protocolStats === null || typeof stats.protocolStats === 'object') &&
    typeof stats.health === 'object' &&
    stats.health !== null &&
    typeof stats.kpis === 'object' &&
    stats.kpis !== null &&
    Array.isArray(stats.series) &&
    Array.isArray(stats.latestTransactions) &&
    typeof stats.latestTransactionsPagination === 'object' &&
    stats.latestTransactionsPagination !== null &&
    typeof stats.networkComparison === 'object' &&
    stats.networkComparison !== null
  );
}
