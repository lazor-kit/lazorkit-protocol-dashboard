// GET /api/protocol-stats?cluster= : compatibility alias returning each program's current on-chain state.

import { isCluster } from '../src/types/dashboard.js';
import { first, methodNotAllowed, type ApiRequest, type ApiResponse } from './_lib/http.js';
import type { RawDashboard } from './_lib/payload.js';
import { callRpc, readTarget, SupabaseError } from './_lib/supabase.js';

export default async function handler(request: ApiRequest, response: ApiResponse) {
  if (methodNotAllowed(request, response)) return;
  const cluster = first(request.query.cluster) ?? 'mainnet';
  if (!isCluster(cluster)) return response.status(400).json({ error: 'Unsupported cluster (mainnet or devnet)' });
  try {
    const raw = await callRpc<RawDashboard>(readTarget(), 'lk_dashboard', { p_cluster: cluster, p_window: '24h' });
    response.setHeader('cache-control', 'public, s-maxage=300, stale-while-revalidate=600');
    return response.status(200).json({
      cluster,
      setupRequired: false,
      programs: raw.programs.map((program) => ({
        programKey: program.programKey,
        version: program.version,
        programId: program.programId,
        deployStatus: program.deployment.status,
        state: program.state,
        stateDetail: program.stateDetail,
        stateSlot: program.stateSlot,
        stateFetchedAt: program.stateFetchedAt,
      })),
    });
  } catch (error) {
    if (error instanceof SupabaseError && (error.kind === 'schema_missing' || error.kind === 'not_configured')) {
      response.setHeader('cache-control', 'public, s-maxage=60');
      return response.status(200).json({ cluster, setupRequired: true, programs: [] });
    }
    response.setHeader('cache-control', 'no-store');
    return response.status(503).json({ cluster, error: 'Data service unavailable' });
  }
}
