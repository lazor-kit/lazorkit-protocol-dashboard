// GET /api/cron/heartbeat: the daily Vercel cron (vercel.json, production only).
// 1. reads the indexer workflow's state from the public GitHub API;
// 2. writes lk_heartbeat('vercel-cron', ...) with the service-role key.
// The write keeps the free Supabase project from pausing even if GitHub stops running the indexer, and the
// workflow state turns the site banner red ("GitHub disabled the scheduled workflow").
// Answers 404 outside production and 401 without `Authorization: Bearer $CRON_SECRET`.

import { fetchWorkflowStatus } from '../_lib/github.js';
import { header, methodNotAllowed, type ApiRequest, type ApiResponse } from '../_lib/http.js';
import { callRpc, writeTarget } from '../_lib/supabase.js';

export interface HeartbeatDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export function createHeartbeatHandler(deps: HeartbeatDeps = {}) {
  return async function handler(request: ApiRequest, response: ApiResponse) {
    const env = deps.env ?? process.env;
    response.setHeader('cache-control', 'no-store');
    if (env.VERCEL_ENV !== 'production') return response.status(404).json({ error: 'Not found' });
    if (methodNotAllowed(request, response)) return;
    const secret = env.CRON_SECRET?.trim();
    if (!secret || header(request, 'authorization') !== `Bearer ${secret}`) {
      return response.status(401).json({ error: 'Unauthorized' });
    }
    const owner = env.VERCEL_GIT_REPO_OWNER?.trim() || 'lazor-kit';
    const repo = env.VERCEL_GIT_REPO_SLUG?.trim() || 'lazorkit-protocol-dashboard';
    const workflow = await fetchWorkflowStatus(owner, repo, deps.fetchImpl ?? fetch);
    const detail = { ...workflow, repository: `${owner}/${repo}`, checked_at: new Date().toISOString() };
    try {
      await callRpc(writeTarget(env), 'lk_heartbeat', { p_source: 'vercel-cron', p_detail: detail }, { fetchImpl: deps.fetchImpl });
    } catch (error) {
      return response.status(503).json({ ok: false, error: error instanceof Error ? error.message : 'heartbeat failed', workflow });
    }
    return response.status(200).json({ ok: true, workflow });
  };
}

export default createHeartbeatHandler();
