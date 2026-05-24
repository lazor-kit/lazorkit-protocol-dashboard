import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import dashboardHandler from './dashboard.js';
import cronHandler from './cron/indexer.js';
import protocolStatsHandler from './protocol-stats.js';

function response() {
  const state = {
    code: 200,
    headers: new Map<string, string>(),
    body: undefined as unknown,
  };
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

describe('api handlers', () => {
  it('rejects invalid dashboard cluster and window', async () => {
    const invalidCluster = response();
    await dashboardHandler(
      { method: 'GET', query: { cluster: 'bad', window: '24h' } },
      invalidCluster.res,
    );
    expect(invalidCluster.state.code).toBe(400);

    const invalidWindow = response();
    await dashboardHandler(
      { method: 'GET', query: { cluster: 'mainnet', window: '90d' } },
      invalidWindow.res,
    );
    expect(invalidWindow.state.code).toBe(400);
  });

  it('rejects invalid dashboard pagination', async () => {
    const invalidPage = response();
    await dashboardHandler(
      {
        method: 'GET',
        query: { cluster: 'mainnet', window: '24h', txPage: '0' },
      },
      invalidPage.res,
    );
    expect(invalidPage.state.code).toBe(400);

    const invalidLimit = response();
    await dashboardHandler(
      {
        method: 'GET',
        query: { cluster: 'mainnet', window: '24h', txLimit: '20' },
      },
      invalidLimit.res,
    );
    expect(invalidLimit.state.code).toBe(400);
  });

  it('returns setup-safe dashboard json without secrets when Supabase is absent', async () => {
    const prevUrl = process.env.SUPABASE_URL;
    const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    const result = response();
    await dashboardHandler(
      { method: 'GET', query: { cluster: 'mainnet', window: '24h' } },
      result.res,
    );

    restoreEnv('SUPABASE_URL', prevUrl);
    restoreEnv('SUPABASE_SERVICE_ROLE_KEY', prevKey);

    const bodyText = JSON.stringify(result.state.body);
    expect(result.state.code).toBe(200);
    expect(bodyText).not.toContain('RPC_URL');
    expect(bodyText).not.toContain('SUPABASE');
    expect(bodyText).not.toContain('service');
    expect(bodyText).toContain('latestTransactionsPagination');
    expect(bodyText).toContain('analyticsStatus');
    expect(bodyText).toContain('not_configured');
  });

  it('keeps the Vercel cron endpoint disabled', async () => {
    const result = response();

    await cronHandler(
      { method: 'GET', query: { cluster: 'mainnet' }, headers: {} },
      result.res,
    );

    expect(result.state.code).toBe(410);
    expect(JSON.stringify(result.state.body)).toContain('GitHub Actions');
  });

  it('returns setup-safe protocol stats without Supabase', async () => {
    const prevUrl = process.env.SUPABASE_URL;
    const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    const result = response();
    await protocolStatsHandler(
      { method: 'GET', query: { cluster: 'mainnet' } },
      result.res,
    );

    restoreEnv('SUPABASE_URL', prevUrl);
    restoreEnv('SUPABASE_SERVICE_ROLE_KEY', prevKey);

    expect(result.state.code).toBe(200);
    expect(result.state.body).toMatchObject({
      cluster: 'mainnet',
      initialized: false,
      feeRecords: [],
      shards: [],
    });
  });

  it('keeps deployed Vercel API routes free of Solana RPC imports', () => {
    const apiFiles = [
      'api/dashboard.ts',
      'api/protocol-stats.ts',
      'api/cron/indexer.ts',
      'api/_lib/analytics.ts',
      'api/_lib/database.ts',
      'api/_lib/env.ts',
    ];
    const forbidden = [
      '@solana/web3.js',
      'rpc-websockets',
      './protocolStats',
      './protocolStats.js',
      '../_lib/indexer',
      '../_lib/indexer.js',
      './indexer',
      './indexer.js',
      './transactionParser',
      './transactionParser.js',
    ];

    for (const file of apiFiles) {
      const source = readFileSync(join(process.cwd(), file), 'utf8');
      for (const pattern of forbidden) {
        expect(source, `${file} imports ${pattern}`).not.toContain(pattern);
      }
    }
  });
});

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
