import dashboardHandler from './dashboard';
import cronHandler from './cron/indexer';

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
  });

  it('rejects cron requests without the configured secret', async () => {
    const prevSecret = process.env.CRON_SECRET;
    process.env.CRON_SECRET = 'secret';
    const result = response();

    await cronHandler(
      { method: 'GET', query: { cluster: 'mainnet' }, headers: {} },
      result.res,
    );

    restoreEnv('CRON_SECRET', prevSecret);
    expect(result.state.code).toBe(401);
  });
});

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
