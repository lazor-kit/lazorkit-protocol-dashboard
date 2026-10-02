// URL state (spec §11.1): ?cluster=mainnet|devnet&window=24h|7d|30d|all&version=all|1|2, kept in sync with
// history.replaceState. Unknown values fall back to the defaults instead of failing.

import { isCluster, isDashboardWindow, type Cluster, type DashboardWindow } from '../types/dashboard';

export type VersionFilter = 'all' | '1' | '2';

export interface UrlState {
  cluster: Cluster;
  window: DashboardWindow;
  version: VersionFilter;
}

export const DEFAULT_WINDOW: DashboardWindow = '30d';

export function isVersionFilter(value: unknown): value is VersionFilter {
  return value === 'all' || value === '1' || value === '2';
}

export function defaultCluster(raw: string | undefined): Cluster {
  return raw === 'devnet' ? 'devnet' : 'mainnet';
}

export function parseUrlState(search: string, fallbackCluster: Cluster): UrlState {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const cluster = params.get('cluster');
  const window = params.get('window');
  const version = params.get('version');
  return {
    cluster: isCluster(cluster) ? cluster : fallbackCluster,
    window: isDashboardWindow(window) ? window : DEFAULT_WINDOW,
    version: isVersionFilter(version) ? version : 'all',
  };
}

/** Writes every key so a shared link reproduces the view exactly; other query parameters are kept. */
export function serializeUrlState(state: UrlState, currentSearch = ''): string {
  const params = new URLSearchParams(currentSearch.startsWith('?') ? currentSearch.slice(1) : currentSearch);
  params.set('cluster', state.cluster);
  params.set('window', state.window);
  params.set('version', state.version);
  return `?${params.toString()}`;
}
