import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';
import dashboardHandler, { clearDashboardMemo } from './dashboard.js';
import healthHandler, { healthHttpStatus } from './health.js';
import protocolStatsHandler from './protocol-stats.js';
import { createHeartbeatHandler } from './cron/heartbeat.js';
import { computeFreshness, type FreshnessProgram } from './_lib/freshness.js';
import type { Heartbeats } from '../src/types/dashboard.js';

function response() {
  const state = { code: 200, headers: new Map<string, string>(), body: undefined as unknown };
  return {
    state,
    res: {
      setHeader(name: string, value: string) {
        state.headers.set(name.toLowerCase(), value);
      },
      status(code: number) {
        state.code = code;
        return {
          json(body: unknown) {
            state.body = body;
          },
        };
      },
    },
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const ENV_KEYS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY', 'SUPABASE_READ_KEY'];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.SUPABASE_URL = 'https://db.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service.jwt.key';
  delete process.env.SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_READ_KEY;
  clearDashboardMemo();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.unstubAllGlobals();
});

const now = new Date('2026-10-02T12:00:00Z');
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000).toISOString();

function program(overrides: Partial<FreshnessProgram> = {}): FreshnessProgram {
  return { programKey: 1, label: 'v1 mainnet', live: true, backfillComplete: true, pending: 0, ingested: 100,
    consecutiveFailures: 0, completeThrough: hoursAgo(1), ...overrides };
}

function rawDashboard(heartbeats: Heartbeats = { worker: { at: hoursAgo(1), detail: {} } }) {
  return {
    dbSchemaVersion: 1,
    cluster: 'mainnet',
    window: '7d',
    generatedAt: now.toISOString(),
    range: { start: hoursAgo(144), end: now.toISOString(), previousStart: hoursAgo(312), bucket: 'day' },
    programs: [{
      programKey: 1, cluster: 'mainnet', version: 1, programId: 'LazorjRFNavitUaBu5m3WaNPjU1maipvSW2rZfAFAKi', label: 'v1 mainnet',
      deployment: { status: 'live' },
      sync: { backfillComplete: true, pending: 0, ingested: 1449, consecutiveFailures: 0, completeThrough: hoursAgo(1) },
    }],
    kpis: {}, series: [], breakdowns: {}, migration: null, binaries: [], latest: [], runs: [],
    heartbeats,
  };
}

describe('freshness state machine (§10.3)', () => {
  const cases: Array<[string, { programs: FreshnessProgram[]; heartbeats: Heartbeats }, string]> = [
    ['live', { programs: [program()], heartbeats: { worker: { at: hoursAgo(1), detail: {} } } }, 'live'],
    ['no worker heartbeat yet', { programs: [program()], heartbeats: {} }, 'catching_up'],
    ['backfill running', { programs: [program({ backfillComplete: false, pending: 900 })], heartbeats: { worker: { at: hoursAgo(0.1), detail: {} } } }, 'catching_up'],
    ['backlog', { programs: [program({ pending: 12 })], heartbeats: { worker: { at: hoursAgo(0.1), detail: {} } } }, 'catching_up'],
    ['worker 9 h old', { programs: [program()], heartbeats: { worker: { at: hoursAgo(9), detail: {} } } }, 'delayed'],
    ['2 consecutive failures', { programs: [program({ consecutiveFailures: 2 })], heartbeats: { worker: { at: hoursAgo(1), detail: {} } } }, 'delayed'],
    ['worker 25 h old', { programs: [program()], heartbeats: { worker: { at: hoursAgo(25), detail: {} } } }, 'stale'],
    ['workflow disabled (fresh cron heartbeat)', { programs: [program()], heartbeats: {
      worker: { at: hoursAgo(1), detail: {} }, 'vercel-cron': { at: hoursAgo(20), detail: { workflow_state: 'disabled_inactivity' } } } }, 'stale'],
    ['workflow disabled but cron heartbeat older than 48 h', { programs: [program()], heartbeats: {
      worker: { at: hoursAgo(1), detail: {} }, 'vercel-cron': { at: hoursAgo(49), detail: { workflow_state: 'disabled_inactivity' } } } }, 'live'],
    ['not-deployed programs are ignored', { programs: [program(), program({ programKey: 2, live: false, backfillComplete: false })],
      heartbeats: { worker: { at: hoursAgo(1), detail: {} } } }, 'live'],
    ['stale wins over catching up', { programs: [program({ pending: 5 })], heartbeats: { worker: { at: hoursAgo(30), detail: {} } } }, 'stale'],
  ];
  for (const [name, input, expected] of cases) {
    it(name, () => {
      expect(computeFreshness({ now, ...input }).state).toBe(expected);
    });
  }

  it('reports reasons, complete-through and catch-up progress', () => {
    const freshness = computeFreshness({
      now,
      programs: [program({ completeThrough: hoursAgo(3) }), program({ programKey: 4, label: 'v2 devnet', backfillComplete: false, pending: 300, ingested: 700, completeThrough: hoursAgo(1) })],
      heartbeats: { worker: { at: hoursAgo(0.2), detail: {} }, 'vercel-cron': { at: hoursAgo(2), detail: { workflow_state: 'active', last_scheduled_run_at: hoursAgo(1), last_conclusion: 'success' } } },
    });
    expect(freshness.completeThrough).toBe(hoursAgo(3));
    expect(freshness.catchUp).toEqual([{ programKey: 4, pending: 300, ingested: 700, percent: 70 }]);
    expect(freshness.reasons.map((r) => r.code)).toEqual(['backfill']);
    expect(freshness.workflow).toMatchObject({ state: 'active', lastConclusion: 'success' });
  });
});

describe('GET /api/dashboard', () => {
  it('rejects unknown clusters (incl. localnet) and windows', async () => {
    for (const query of [{ cluster: 'localnet', window: '7d' }, { cluster: 'bad' }, { cluster: 'mainnet', window: '90d' }]) {
      const result = response();
      await dashboardHandler({ method: 'GET', query }, result.res);
      expect(result.state.code).toBe(400);
    }
  });

  it('PGRST202 (migration not applied) answers 200 setup_required', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 'PGRST202', message: 'Could not find the function' }, 404)));
    const result = response();
    await dashboardHandler({ method: 'GET', query: { cluster: 'mainnet', window: '7d' } }, result.res);
    expect(result.state.code).toBe(200);
    expect(result.state.body).toMatchObject({ apiVersion: 2, freshness: { state: 'setup_required' }, programs: [] });
    expect(result.state.headers.get('cache-control')).toBe('public, s-maxage=60');
  });

  it('a missing Supabase configuration is setup_required too, and leaks no secret names', async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const result = response();
    await dashboardHandler({ method: 'GET', query: { cluster: 'devnet', window: '24h' } }, result.res);
    expect(result.state.code).toBe(200);
    const text = JSON.stringify(result.state.body);
    expect(text).toContain('setup_required');
    expect(text).not.toMatch(/SUPABASE|service|RPC_URL/);
  });

  it('a network error (paused project) answers 503 unavailable, not cached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed');
    }));
    const result = response();
    await dashboardHandler({ method: 'GET', query: { cluster: 'mainnet', window: '7d' } }, result.res);
    expect(result.state.code).toBe(503);
    expect(result.state.body).toMatchObject({ freshness: { state: 'unavailable' } });
    expect(result.state.headers.get('cache-control')).toBe('no-store');
  });

  it('a 5xx / PGRST002 answers 503', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 'PGRST002' }, 503)));
    const result = response();
    await dashboardHandler({ method: 'GET', query: { cluster: 'mainnet', window: '7d' } }, result.res);
    expect(result.state.code).toBe(503);
  });

  it('serves the payload with freshness, CDN caching and an instance memo', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://db.test/rest/v1/rpc/lk_dashboard');
      expect(JSON.parse(String(init?.body))).toEqual({ p_cluster: 'mainnet', p_window: '7d' });
      return jsonResponse(rawDashboard());
    });
    vi.stubGlobal('fetch', fetchMock);
    const first = response();
    await dashboardHandler({ method: 'GET', query: { cluster: 'mainnet', window: '7d' } }, first.res);
    expect(first.state.code).toBe(200);
    expect(first.state.body).toMatchObject({ apiVersion: 2, cluster: 'mainnet', freshness: { state: expect.any(String) } });
    expect(first.state.body).not.toHaveProperty('heartbeats');
    expect(first.state.headers.get('cache-control')).toBe('public, s-maxage=300, stale-while-revalidate=900');
    const second = response();
    await dashboardHandler({ method: 'GET', query: { cluster: 'mainnet', window: '7d' } }, second.res);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('an old schema version is setup_required', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ...rawDashboard(), dbSchemaVersion: 0 })));
    const result = response();
    await dashboardHandler({ method: 'GET', query: { cluster: 'mainnet', window: '7d' } }, result.res);
    expect(result.state.body).toMatchObject({ freshness: { state: 'setup_required' } });
  });

  it('only GET', async () => {
    const result = response();
    await dashboardHandler({ method: 'POST', query: {} }, result.res);
    expect(result.state.code).toBe(405);
  });
});

describe('GET /api/health', () => {
  it('maps states to HTTP codes', () => {
    expect([healthHttpStatus('live'), healthHttpStatus('catching_up'), healthHttpStatus('delayed')]).toEqual([200, 200, 200]);
    expect([healthHttpStatus('stale'), healthHttpStatus('unavailable'), healthHttpStatus('setup_required')]).toEqual([503, 503, 503]);
  });

  it('answers 200 live and 503 stale from lk_health', async () => {
    const health = (workerAt: string) => ({
      schemaVersion: 1, generatedAt: now.toISOString(),
      programs: [{ programKey: 1, label: 'v1 mainnet', deployStatus: 'live', backfillComplete: true, pending: 0, ingested: 9,
        consecutiveFailures: 0, completeThrough: new Date().toISOString(), checks: [] }],
      heartbeats: { worker: { at: workerAt, detail: {} } },
    });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(health(new Date().toISOString()))));
    const live = response();
    await healthHandler({ method: 'GET', query: {} }, live.res);
    expect(live.state.code).toBe(200);
    expect(live.state.body).toMatchObject({ status: 'live', workflowState: 'unknown' });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(health(new Date(Date.now() - 30 * 3600_000).toISOString()))));
    const stale = response();
    await healthHandler({ method: 'GET', query: {} }, stale.res);
    expect(stale.state.code).toBe(503);
    expect(stale.state.body).toMatchObject({ status: 'stale' });
  });

  it('answers 503 setup_required without the migration', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 'PGRST202' }, 404)));
    const result = response();
    await healthHandler({ method: 'GET', query: {} }, result.res);
    expect(result.state.code).toBe(503);
    expect(result.state.body).toMatchObject({ status: 'setup_required' });
  });
});

describe('GET /api/protocol-stats', () => {
  it('is setup-safe without the migration', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 'PGRST202' }, 404)));
    const result = response();
    await protocolStatsHandler({ method: 'GET', query: { cluster: 'devnet' } }, result.res);
    expect(result.state.code).toBe(200);
    expect(result.state.body).toEqual({ cluster: 'devnet', setupRequired: true, programs: [] });
  });
});

describe('GET /api/cron/heartbeat', () => {
  const prodEnv = { VERCEL_ENV: 'production', CRON_SECRET: 'cron-secret-value', SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'service.jwt.key' };

  it('is 404 outside production (previews never write)', async () => {
    const handler = createHeartbeatHandler({ env: { ...prodEnv, VERCEL_ENV: 'preview' }, fetchImpl: vi.fn() as unknown as typeof fetch });
    const result = response();
    await handler({ method: 'GET', query: {}, headers: { authorization: 'Bearer cron-secret-value' } }, result.res);
    expect(result.state.code).toBe(404);
  });

  it('is 401 with a missing or wrong secret, and when CRON_SECRET is empty', async () => {
    const fetchImpl = vi.fn();
    for (const [env, auth] of [[prodEnv, undefined], [prodEnv, 'Bearer nope'], [{ ...prodEnv, CRON_SECRET: '' }, 'Bearer ']] as const) {
      const handler = createHeartbeatHandler({ env, fetchImpl: fetchImpl as unknown as typeof fetch });
      const result = response();
      await handler({ method: 'GET', query: {}, headers: auth ? { authorization: auth } : {} }, result.res);
      expect(result.state.code).toBe(401);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('in production reads the workflow state from GitHub and writes lk_heartbeat with the service-role key', async () => {
    const calls: Array<{ url: string; body?: unknown; headers?: Record<string, string> }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: init?.headers as Record<string, string> });
      if (url.endsWith('/actions/workflows/indexer.yml')) return jsonResponse({ state: 'disabled_inactivity' });
      if (url.includes('/runs?')) return jsonResponse({ workflow_runs: [{ created_at: '2026-07-23T16:03:00Z', conclusion: 'success' }] });
      return jsonResponse(null);
    });
    const handler = createHeartbeatHandler({ env: prodEnv, fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = response();
    await handler({ method: 'GET', query: {}, headers: { authorization: 'Bearer cron-secret-value' } }, result.res);
    expect(result.state.code).toBe(200);
    expect(calls[0].url).toBe('https://api.github.com/repos/lazor-kit/lazorkit-protocol-dashboard/actions/workflows/indexer.yml');
    const rpc = calls.find((c) => c.url === 'https://db.test/rest/v1/rpc/lk_heartbeat');
    expect(rpc?.body).toMatchObject({ p_source: 'vercel-cron', p_detail: { workflow_state: 'disabled_inactivity',
      last_scheduled_run_at: '2026-07-23T16:03:00Z', last_conclusion: 'success' } });
    expect(rpc?.headers?.apikey).toBe('service.jwt.key');
    expect(result.state.headers.get('cache-control')).toBe('no-store');
  });
});

describe('static guards', () => {
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
    });
  }

  it('api/** never imports worker code, @solana/web3.js or @lazorkit/*', () => {
    const forbidden = [/from ['"][^'"]*worker\//, /from ['"]@solana\/web3\.js['"]/, /from ['"]@lazorkit\//, /import ['"][^'"]*worker\//];
    for (const file of files(join(process.cwd(), 'api'))) {
      if (file.endsWith('.test.ts')) continue;
      const source = readFileSync(file, 'utf8');
      for (const pattern of forbidden) expect(source, `${file} matches ${pattern}`).not.toMatch(pattern);
    }
  });

  it('vercel.json only registers the daily heartbeat cron', () => {
    const config = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8'));
    expect(config).toEqual({ crons: [{ path: '/api/cron/heartbeat', schedule: '17 12 * * *' }] });
  });
});
