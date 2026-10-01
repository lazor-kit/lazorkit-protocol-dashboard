import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchDashboard, type DashboardResult } from '../api/fetchDashboard';
import { AppShell } from '../components/AppShell';
import { DashboardHeader } from '../components/DashboardHeader';
import type { Cluster, DashboardWindow, Freshness } from '../types/dashboard';
import { Dashboard } from './Dashboard';
import { defaultCluster, parseUrlState, serializeUrlState, type UrlState, type VersionFilter } from './urlState';
import { viewFromResult } from './view';

const AUTO_REFRESH_MS = 5 * 60_000;
const CLOCK_TICK_MS = 30_000;

export function App() {
  const [state, setState] = useState<UrlState>(() =>
    parseUrlState(window.location.search, defaultCluster(import.meta.env.VITE_DEFAULT_CLUSTER)),
  );
  const [loaded, setLoaded] = useState<{ key: string; token: number; result: DashboardResult } | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const expandAll = useMemo(() => window.location.hash === '#all-details', []);
  const key = `${state.cluster}:${state.window}`;
  const loading = !loaded || loaded.key !== key || loaded.token !== reloadToken;

  useEffect(() => {
    const search = serializeUrlState(state, window.location.search);
    if (search !== window.location.search) {
      window.history.replaceState(null, '', `${window.location.pathname}${search}${window.location.hash}`);
    }
  }, [state]);

  useEffect(() => {
    const controller = new AbortController();
    fetchDashboard(state.cluster, state.window, { signal: controller.signal })
      .then((result) => {
        setLoaded({ key, token: reloadToken, result });
        setNow(Date.now());
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : 'Unable to load the dashboard.';
        setLoaded({ key, token: reloadToken, result: { kind: 'error', message, cached: null } });
      });
    return () => controller.abort();
  }, [state.cluster, state.window, key, reloadToken]);

  useEffect(() => {
    const clock = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    const refresh = window.setInterval(() => {
      if (document.visibilityState === 'visible') setReloadToken((token) => token + 1);
    }, AUTO_REFRESH_MS);
    return () => {
      window.clearInterval(clock);
      window.clearInterval(refresh);
    };
  }, []);

  const view = useMemo(() => viewFromResult(loaded && loaded.key === key ? loaded.result : null, now), [loaded, key, now]);
  const freshness: Freshness | null =
    view.kind === 'data' || view.kind === 'setup_required' ? view.payload.freshness : view.kind === 'unavailable' ? view.freshness : null;
  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  return (
    <AppShell>
      <DashboardHeader
        cluster={state.cluster}
        window={state.window}
        version={state.version}
        freshness={freshness}
        loading={loading}
        now={now}
        onCluster={(cluster: Cluster) => setState((current) => ({ ...current, cluster }))}
        onWindow={(window: DashboardWindow) => setState((current) => ({ ...current, window }))}
        onVersion={(version: VersionFilter) => setState((current) => ({ ...current, version }))}
        onRefresh={refresh}
      />
      <Dashboard view={view} version={state.version} now={now} expandAll={expandAll} onRetry={refresh} />
    </AppShell>
  );
}
