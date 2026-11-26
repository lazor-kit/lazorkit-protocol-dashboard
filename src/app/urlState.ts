import { isCluster, isDashboardWindow, type Cluster, type DashboardWindow } from '../types/dashboard';

export type VersionFilter = 'all' | '1' | '2';

export interface UrlState {
  cluster: Cluster;
  window: DashboardWindow;
}

export const DEFAULT_WINDOW: DashboardWindow = '30d';

export function defaultCluster(raw: string | undefined): Cluster {
  return raw === 'devnet' ? 'devnet' : 'mainnet';
}

export function parseUrlState(search: string, fallbackCluster: Cluster): UrlState {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const cluster = params.get('cluster');
  const window = params.get('window');
  return {
    cluster: isCluster(cluster) ? cluster : fallbackCluster,
    window: isDashboardWindow(window) ? window : DEFAULT_WINDOW,
  };
}

/** Keep unrelated query parameters and drop the retired version filter from shared links. */
export function serializeUrlState(state: UrlState, currentSearch = ''): string {
  const params = new URLSearchParams(currentSearch.startsWith('?') ? currentSearch.slice(1) : currentSearch);
  params.set('cluster', state.cluster);
  params.set('window', state.window);
  params.delete('version');
  return `?${params.toString()}`;
}
