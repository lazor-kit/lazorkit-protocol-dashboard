import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeClock, fakeEndpoint, RpcFailure } from '../testing/fakeRpc.js';
import { redactText, redactUrl, RpcClient, RpcError } from './client.js';
import { methodClass, Pacer } from './limiter.js';

describe('rpc client', () => {
  it('honours Retry-After on a 429 and halves that class rate', async () => {
    let calls = 0;
    const endpoint = fakeEndpoint('https://rpc.test', {
      getTransaction: () => (++calls === 1 ? new Response('{"code":429}', { status: 429, headers: { 'retry-after': '7' } }) : { ok: 1 }),
    });
    const clock = fakeClock();
    const client = new RpcClient({ url: endpoint.url, heavyRps: 4, lightRps: 8, clock, fetchImpl: endpoint.fetch });
    expect(await client.call('getTransaction', ['sig'])).toEqual({ ok: 1 });
    expect(calls).toBe(2);
    expect(clock.slept.some((ms) => ms >= 7000)).toBe(true);
    expect(client.rate('heavy')).toBe(2);
    expect(client.rate('light')).toBe(8);
    expect(client.throttles.getTransaction).toBe(1);
  });

  it('uses 10 s when a 429 has no Retry-After, also for a 429 inside a 200 body', async () => {
    let calls = 0;
    const endpoint = fakeEndpoint('https://rpc.test', {
      getSignaturesForAddress: () => (++calls === 1 ? new RpcFailure(429, 'Too many requests') : []),
    });
    const clock = fakeClock();
    const client = new RpcClient({ url: endpoint.url, heavyRps: 1, lightRps: 4, clock, fetchImpl: endpoint.fetch });
    expect(await client.call('getSignaturesForAddress', ['p', {}])).toEqual([]);
    expect(clock.slept.some((ms) => ms >= 10_000)).toBe(true);
    expect(client.rate('heavy')).toBe(0.5);
  });

  it('never lets the rate fall below 0.25/s and gives up after 6 throttled retries', async () => {
    const endpoint = fakeEndpoint('https://rpc.test', { getTransaction: () => new Response('', { status: 429 }) });
    const client = new RpcClient({ url: endpoint.url, heavyRps: 1, lightRps: 4, clock: fakeClock(), fetchImpl: endpoint.fetch });
    await expect(client.call('getTransaction', ['s'])).rejects.toThrow('still rate limited');
    expect(endpoint.calls).toHaveLength(7);
    expect(client.rate('heavy')).toBe(0.25);
  });

  it('retries 5xx and network errors 3 times with 1, 2, 4 s pauses', async () => {
    let calls = 0;
    const endpoint = fakeEndpoint('https://rpc.test', {
      getBlockTime: () => {
        calls += 1;
        if (calls === 1) return new Response('bad gateway', { status: 502 });
        if (calls === 2) throw new TypeError('fetch failed');
        return 1_790_000_000;
      },
    });
    const clock = fakeClock();
    const client = new RpcClient({ url: endpoint.url, heavyRps: 1000, lightRps: 1000, clock, fetchImpl: endpoint.fetch });
    expect(await client.call('getBlockTime', [1])).toBe(1_790_000_000);
    expect(clock.slept.filter((ms) => ms >= 1000)).toEqual([1000, 2000]);
    const failing = fakeEndpoint('https://rpc.test', { getBlockTime: () => new Response('', { status: 503 }) });
    const client2 = new RpcClient({ url: failing.url, heavyRps: 1000, lightRps: 1000, clock: fakeClock(), fetchImpl: failing.fetch });
    await expect(client2.call('getBlockTime', [1])).rejects.toBeInstanceOf(RpcError);
    expect(failing.calls).toHaveLength(4);
  });

  it('JSON-RPC errors are not retried and carry their code', async () => {
    const endpoint = fakeEndpoint('https://rpc.test', { getTransaction: () => new RpcFailure(-32015, 'Transaction version (1) is not supported') });
    const client = new RpcClient({ url: endpoint.url, heavyRps: 1000, lightRps: 1000, clock: fakeClock(), fetchImpl: endpoint.fetch });
    const error = await client.call('getTransaction', ['s']).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).code).toBe(-32015);
    expect(endpoint.calls).toHaveLength(1);
  });

  it('paces each method class separately', async () => {
    const clock = fakeClock();
    const heavy = new Pacer(1, clock);
    const light = new Pacer(4, clock);
    await heavy.take();
    await heavy.take();
    await light.take();
    await light.take();
    expect(clock.slept).toEqual([1000, 250]);
    expect(methodClass('getTransaction')).toBe('heavy');
    expect(methodClass('getProgramAccounts')).toBe('heavy');
    expect(methodClass('getAccountInfo')).toBe('light');
    expect(methodClass('getMultipleAccounts')).toBe('light');
  });

  it('redacts keys from URLs and log lines', () => {
    expect(redactUrl('https://mainnet.helius-rpc.com/?api-key=SECRET123456')).toBe('https://mainnet.helius-rpc.com?…');
    expect(redactUrl('https://x.quiknode.pro/abcdef0123456789/')).toBe('https://x.quiknode.pro/…');
    expect(redactUrl('https://api.devnet.solana.com')).toBe('https://api.devnet.solana.com');
    expect(redactText('failed https://x.quiknode.pro/abcdef0123456789/ now', ['https://x.quiknode.pro/abcdef0123456789/']))
      .toBe('failed <redacted> now');
    const logs: string[] = [];
    const endpoint = fakeEndpoint('https://rpc.test/token-abcdef', { getTransaction: () => new Response('', { status: 429 }) });
    const client = new RpcClient({ url: endpoint.url, heavyRps: 1, lightRps: 1, clock: fakeClock(), fetchImpl: endpoint.fetch, log: (l) => logs.push(l), max429Retries: 1 });
    return client.call('getTransaction', ['s']).catch(() => {
      expect(logs.length).toBeGreaterThan(0);
      expect(logs.join('\n')).not.toContain('token-abcdef');
    });
  });

  it('caches getTransaction results on disk when a cache dir is set (dev only)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lk-cache-'));
    try {
      const sig = '5oJVgxEnA4Mze99X62VFVxcAMnYAiBkPxBVgn58d1AnRkeGYhJHeidv3uFkqQMAMiyE1aH1BxgnQ3YYjHo7eFb36';
      const endpoint = fakeEndpoint('https://rpc.test', { getTransaction: () => ({ slot: 1 }) });
      const client = new RpcClient({ url: endpoint.url, heavyRps: 1000, lightRps: 1000, clock: fakeClock(), fetchImpl: endpoint.fetch, txCacheDir: dir });
      await client.call('getTransaction', [sig, {}]);
      await client.call('getTransaction', [sig, {}]);
      expect(endpoint.calls).toHaveLength(1);
      expect(readdirSync(dir)).toEqual([`${sig}.json`]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
