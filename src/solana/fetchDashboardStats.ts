import {
  isDashboardWindow,
  type DashboardStats,
  type DashboardWindow,
} from './dashboardTypes';
import { isClusterId, type ClusterId } from './shared';

export async function fetchDashboardStats(
  cluster: ClusterId,
  window: DashboardWindow,
): Promise<DashboardStats> {
  const response = await fetch(`/api/dashboard?cluster=${cluster}&window=${window}`, {
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
    typeof stats.health === 'object' &&
    stats.health !== null &&
    typeof stats.kpis === 'object' &&
    stats.kpis !== null &&
    Array.isArray(stats.series) &&
    Array.isArray(stats.latestTransactions) &&
    typeof stats.networkComparison === 'object' &&
    stats.networkComparison !== null
  );
}
