// GET /api/health: for uptime monitors. 200 when live / catching_up / delayed; 503 when stale / unavailable /
// setup_required. `lastWorkerTrigger` says what started the last indexer run (schedule, repository_dispatch, ...).

import { first, methodNotAllowed, type ApiRequest, type ApiResponse } from './_lib/http.js';
import { fixedFreshness } from './_lib/freshness.js';
import { healthFromRaw, type RawHealth } from './_lib/payload.js';
import { callRpc, readTarget, SupabaseError } from './_lib/supabase.js';
import { DASHBOARD_API_VERSION, type HealthPayload } from '../src/types/dashboard.js';

export function healthHttpStatus(status: HealthPayload['status']): number {
  return status === 'live' || status === 'catching_up' || status === 'delayed' ? 200 : 503;
}

export default async function handler(request: ApiRequest, response: ApiResponse) {
  if (methodNotAllowed(request, response)) return;
  const now = new Date();
  let payload: HealthPayload;
  try {
    const raw = await callRpc<RawHealth>(readTarget(), 'lk_health', {});
    payload = healthFromRaw(raw, now);
  } catch (error) {
    const missing = error instanceof SupabaseError && (error.kind === 'schema_missing' || error.kind === 'not_configured');
    const freshness = missing
      ? fixedFreshness('setup_required', 'the lk_* functions are missing (apply the migration)')
      : fixedFreshness('unavailable', error instanceof Error ? error.message : 'database error');
    payload = {
      apiVersion: DASHBOARD_API_VERSION,
      status: freshness.state,
      dbSchemaVersion: null,
      generatedAt: now.toISOString(),
      completeThrough: null,
      lastWorkerRunAt: null,
      lastWorkerTrigger: null,
      workflowState: 'unknown',
      freshness,
      programs: [],
    };
  }
  const verbose = first(request.query.verbose) === '1';
  response.setHeader('cache-control', 'public, s-maxage=60');
  return response.status(healthHttpStatus(payload.status)).json(verbose ? payload : { ...payload, programs: payload.programs.map(({ checks: _checks, ...rest }) => rest) });
}
