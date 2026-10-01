import { FIXTURES, setupRequiredPayload } from '../test/fixtures';
import { cacheKey, fetchDashboard, readCached, writeCached, type StorageLike } from './fetchDashboard';

class MemoryStorage implements StorageLike {
  data = new Map<string, string>();
  quota = Number.POSITIVE_INFINITY;
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    const used = [...this.data.entries()].filter(([k]) => k !== key).reduce((sum, [, v]) => sum + v.length, 0);
    if (used + value.length > this.quota) throw new DOMException('quota', 'QuotaExceededError');
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
}

const throwingStorage: StorageLike = {
  getItem() {
    throw new Error('blocked');
  },
  setItem() {
    throw new Error('blocked');
  },
  removeItem() {
    throw new Error('blocked');
  },
};

const respond = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

describe('fetchDashboard', () => {
  it('returns and caches a live payload', async () => {
    const storage = new MemoryStorage();
    const payload = FIXTURES['mainnet-30d']();
    const fetchImpl = respond(200, payload);
    const result = await fetchDashboard('mainnet', '30d', { fetchImpl, storage });
    expect(result.kind).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledWith('/api/dashboard?cluster=mainnet&window=30d', expect.anything());
    expect(readCached(storage, 'mainnet', '30d')?.payload.generatedAt).toBe(payload.generatedAt);
  });

  it('treats setup_required as a state, not an error, and does not cache it', async () => {
    const storage = new MemoryStorage();
    const result = await fetchDashboard('devnet', '7d', { fetchImpl: respond(200, setupRequiredPayload()), storage });
    expect(result.kind).toBe('setup_required');
    expect(storage.data.size).toBe(0);
  });

  it('on 503 returns the copy saved in this browser', async () => {
    const storage = new MemoryStorage();
    writeCached(storage, FIXTURES['mainnet-30d'](), '2026-10-01T18:00:00Z');
    const result = await fetchDashboard('mainnet', '30d', {
      fetchImpl: respond(503, { freshness: { state: 'unavailable', reasons: [{ detail: 'database unavailable (HTTP 503)' }] } }),
      storage,
    });
    expect(result).toMatchObject({ kind: 'unavailable', detail: 'database unavailable (HTTP 503)', cached: { savedAt: '2026-10-01T18:00:00Z' } });
  });

  it('on a network error is unavailable, with no copy when nothing was saved', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const result = await fetchDashboard('devnet', '24h', { fetchImpl, storage: new MemoryStorage() });
    expect(result).toEqual({ kind: 'unavailable', detail: 'The dashboard API could not be reached.', cached: null });
  });

  it('reports a 400 as an error', async () => {
    const result = await fetchDashboard('mainnet', '7d', { fetchImpl: respond(400, { error: 'Unsupported cluster' }), storage: null });
    expect(result).toMatchObject({ kind: 'error', message: 'Unsupported cluster' });
  });

  it('works when storage throws on every access', async () => {
    const ok = await fetchDashboard('mainnet', '30d', { fetchImpl: respond(200, FIXTURES['mainnet-30d']()), storage: throwingStorage });
    expect(ok.kind).toBe('ok');
    const down = await fetchDashboard('mainnet', '30d', { fetchImpl: respond(503, {}), storage: throwingStorage });
    expect(down).toMatchObject({ kind: 'unavailable', cached: null });
  });
});

describe('the localStorage copy', () => {
  it('keeps at most four views, newest last', () => {
    const storage = new MemoryStorage();
    for (const name of ['mainnet-24h', 'mainnet-7d', 'mainnet-30d', 'mainnet-all', 'devnet-7d']) writeCached(storage, FIXTURES[name]());
    expect(storage.getItem(cacheKey('mainnet', '24h'))).toBeNull();
    expect(readCached(storage, 'devnet', '7d')).not.toBeNull();
    expect(JSON.parse(storage.getItem('lk-dashboard:v2:index')!)).toHaveLength(4);
  });

  it('evicts older copies when the quota is hit', () => {
    const storage = new MemoryStorage();
    writeCached(storage, FIXTURES['mainnet-7d']());
    storage.quota = storage.getItem(cacheKey('mainnet', '7d'))!.length + JSON.stringify(FIXTURES['devnet-7d']()).length + 400;
    expect(writeCached(storage, FIXTURES['devnet-30d']())).toBe(true);
    expect(storage.getItem(cacheKey('mainnet', '7d'))).toBeNull();
  });

  it('ignores a corrupt or foreign copy', () => {
    const storage = new MemoryStorage();
    storage.setItem(cacheKey('mainnet', '30d'), '{not json');
    expect(readCached(storage, 'mainnet', '30d')).toBeNull();
    storage.setItem(cacheKey('mainnet', '30d'), JSON.stringify({ savedAt: 'x', payload: { apiVersion: 1 } }));
    expect(readCached(storage, 'mainnet', '30d')).toBeNull();
  });
});
