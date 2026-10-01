// GET /api/dashboard?cluster=mainnet|devnet&window=24h|7d|30d|all
// One RPC (lk_dashboard) + freshness computed here. A missing migration (PGRST202) answers 200 with a
// "setup required" payload, so a preview against a database without the migration renders cleanly; a paused or
// unreachable database answers 503 "unavailable" (the SPA then shows its cached copy).

import { isCluster, isDashboardWindow, type Cluster, type DashboardPayload, type DashboardWindow } from '../src/types/dashboard.js';
import { first, methodNotAllowed, type ApiRequest, type ApiResponse } from './_lib/http.js';
import { dashboardFromRaw, setupRequiredDashboard, unavailableBody, type RawDashboard } from './_lib/payload.js';
import { callRpc, readTarget, SupabaseError } from './_lib/supabase.js';

const MEMO_MS = 60_000;
const memo = new Map<string, { at: number; payload: DashboardPayload }>();

export function clearDashboardMemo(): void {
  memo.clear();
}

export default async function handler(request: ApiRequest, response: ApiResponse) {
  if (methodNotAllowed(request, response)) return;
  const cluster = first(request.query.cluster) ?? 'mainnet';
  const window = first(request.query.window) ?? '30d';
  if (!isCluster(cluster)) return response.status(400).json({ error: 'Unsupported cluster (mainnet or devnet)' });
  if (!isDashboardWindow(window)) return response.status(400).json({ error: 'Unsupported window (24h, 7d, 30d or all)' });

  const now = new Date();
  const key = `${cluster}:${window}`;
  const cached = memo.get(key);
  if (cached && now.getTime() - cached.at < MEMO_MS) {
    response.setHeader('cache-control', 'public, s-maxage=300, stale-while-revalidate=900');
    return response.status(200).json(cached.payload);
  }

  try {
    const raw = await callRpc<RawDashboard>(readTarget(), 'lk_dashboard', { p_cluster: cluster, p_window: window });
    const payload = dashboardFromRaw(raw, now);
    if (payload.freshness.state === 'setup_required') {
      response.setHeader('cache-control', 'public, s-maxage=60');
      return response.status(200).json(payload);
    }
    memo.set(key, { at: now.getTime(), payload });
    response.setHeader('cache-control', 'public, s-maxage=300, stale-while-revalidate=900');
    return response.status(200).json(payload);
  } catch (error) {
    return respondError(error, cluster, window, now, response);
  }
}

function respondError(error: unknown, cluster: Cluster, window: DashboardWindow, now: Date, response: ApiResponse) {
  if (error instanceof SupabaseError && (error.kind === 'schema_missing' || error.kind === 'not_configured')) {
    response.setHeader('cache-control', 'public, s-maxage=60');
    return response
      .status(200)
      .json(setupRequiredDashboard(cluster, window, now, error.kind === 'schema_missing' ? 'lk_dashboard is missing' : 'database not configured'));
  }
  const detail =
    error instanceof SupabaseError
      ? `Data service unavailable (${error.message}); the database may be paused.`
      : 'Data service error.';
  response.setHeader('cache-control', 'no-store');
  return response.status(503).json(unavailableBody(cluster, window, now, detail));
}
