// Discovery against a fake chain that throws if `until` is used or if `before` is not a signature it returned.

import { RpcClient } from '../rpc/client.js';
import { fakeClock, fakeEndpoint, MemoryDb, RpcFailure } from '../testing/fakeRpc.js';
import type { SignatureInfo } from '../types.js';
import { discover } from './discover.js';

/** Signatures newest first; slot = 1000 + index-from-oldest; some share slots. */
function history(count: number, sameSlotEvery = 0): SignatureInfo[] {
  const list: SignatureInfo[] = [];
  let slot = 1000;
  for (let i = 0; i < count; i += 1) {
    if (!(sameSlotEvery && i % sameSlotEvery === 1)) slot += 1;
    list.push({ signature: `sig${String(i).padStart(5, '0')}`, slot, blockTime: 1_790_000_000 + slot, err: null });
  }
  return list.reverse();
}

/** A fake getSignaturesForAddress serving `chain` (newest first); `keep` limits how deep this endpoint's history goes. */
function sigsEndpoint(url: string, chain: SignatureInfo[], keep = Infinity, returned = new Set<string>(), lag = 0) {
  const visible = chain.slice(lag, keep);
  const endpoint = fakeEndpoint(url, {
    getSignaturesForAddress: (params) => {
      const options = params[1] as { limit: number; before?: string; until?: string };
      if (options.until) throw new Error('`until` must never be used');
      let start = 0;
      if (options.before) {
        if (!returned.has(options.before)) throw new Error(`before ${options.before} was not returned by this run`);
        start = visible.findIndex((s) => s.signature === options.before) + 1;
        if (start === 0) return new RpcFailure(-32009, 'before signature not found');
      }
      const page = visible.slice(start, start + options.limit);
      for (const s of page) returned.add(s.signature);
      return page;
    },
    getBlockTime: () => 1_790_000_000,
  });
  return { endpoint, returned };
}

function client(endpoint: ReturnType<typeof fakeEndpoint>) {
  return new RpcClient({ url: endpoint.url, heavyRps: 1e6, lightRps: 1e6, clock: fakeClock(), fetchImpl: endpoint.fetch });
}

function memoryDb() {
  return new MemoryDb([{ programKey: 4, cluster: 'devnet', version: 2, programId: 'P', label: 'v2 devnet' }]);
}

describe('discovery', () => {
  it('a fresh build pages to the start of history (more than 1,000 signatures) and queues everything', async () => {
    const chain = history(2500);
    const { endpoint } = sigsEndpoint('https://archive.test', chain);
    const rpc = client(endpoint);
    const db = memoryDb();
    const result = await discover({ primary: rpc, archival: rpc, db }, 4, 'P', { gen: 1, frontierSlot: null });
    expect(result).toMatchObject({ found: 2500, queued: 2500, historyEnd: true, pages: 3 });
    expect(db.pendingFor(4)).toHaveLength(2500);
    expect(db.builds[0]).toMatchObject({ frontierSlot: chain[0].slot, historyEndReached: true, backfillComplete: false });
  });

  it('a short page from the primary is never trusted: discovery continues on the archival endpoint', async () => {
    const chain = history(1500);
    const run = new Set<string>(); // signatures returned by any call of this run
    const primary = sigsEndpoint('https://primary.test', chain, 300, run); // provider keeps only recent history
    const archival = sigsEndpoint('https://archive.test', chain, Infinity, run);
    const db = memoryDb();
    const result = await discover({ primary: client(primary.endpoint), archival: client(archival.endpoint), db }, 4, 'P',
      { gen: 1, frontierSlot: null });
    expect(result).toMatchObject({ found: 1500, historyEnd: true, usedArchival: true });
    expect(primary.endpoint.calls).toHaveLength(1);
    expect(db.pendingFor(4)).toHaveLength(1500);
  });

  it('when the archival endpoint does not know the primary signature it restarts from the top', async () => {
    const chain = history(400);
    const run = new Set<string>();
    const primary = sigsEndpoint('https://primary.test', chain, 100, run);
    const archival = sigsEndpoint('https://archive.test', chain, Infinity, run, 20); // 20 signatures behind
    const db = memoryDb();
    const result = await discover({ primary: client(primary.endpoint), archival: client(archival.endpoint), db, sleep: async () => undefined },
      4, 'P', { gen: 1, frontierSlot: null });
    expect(result).toMatchObject({ found: 400, historyEnd: true });
    expect(db.pendingFor(4)).toHaveLength(400);
  });

  it('an archival endpoint lagging past the primary history is refused instead of skipping signatures', async () => {
    const chain = history(400);
    const run = new Set<string>();
    const primary = sigsEndpoint('https://primary.test', chain, 100, run);
    const archival = sigsEndpoint('https://archive.test', chain, Infinity, run, 150);
    const db = memoryDb();
    await expect(discover({ primary: client(primary.endpoint), archival: client(archival.endpoint), db, sleep: async () => undefined },
      4, 'P', { gen: 1, frontierSlot: null })).rejects.toThrow('lags behind the primary');
    expect(db.pendingFor(4)).toHaveLength(0);
  });

  it('incremental: stops below the frontier, re-collects same-slot siblings, first page is small', async () => {
    const chain = history(50, 3); // pairs of signatures share a slot
    const frontierIndex = 20;
    const frontierSlot = chain[frontierIndex].slot;
    const { endpoint } = sigsEndpoint('https://archive.test', chain);
    const rpc = client(endpoint);
    const db = memoryDb();
    const result = await discover({ primary: rpc, archival: rpc, db }, 4, 'P', { gen: 1, frontierSlot });
    const expected = chain.filter((s) => s.slot >= frontierSlot);
    expect(result.found).toBe(expected.length);
    expect(result.historyEnd).toBe(false);
    expect(expected.some((s, i) => i > 0 && s.slot === expected[i - 1].slot)).toBe(true);
    expect((endpoint.calls[0].params[1] as { limit: number }).limit).toBe(100);
    expect(endpoint.calls).toHaveLength(1);
  });

  it('a quiet program costs one call and moves nothing but discovered_at', async () => {
    const chain = history(10);
    const { endpoint } = sigsEndpoint('https://archive.test', chain);
    const rpc = client(endpoint);
    const db = memoryDb();
    db.builds[0].frontierSlot = chain[0].slot;
    for (const s of chain) db.ledger.set(`4:1:${s.signature}`, []);
    const result = await discover({ primary: rpc, archival: rpc, db }, 4, 'P', { gen: 1, frontierSlot: chain[0].slot });
    expect(result).toMatchObject({ found: 1, queued: 0 });
    expect(endpoint.calls).toHaveLength(1);
    expect(db.builds[0].frontierSlot).toBe(chain[0].slot);
  });

  it('archival history ending above the frontier is an error and moves nothing', async () => {
    const chain = history(30);
    const { endpoint } = sigsEndpoint('https://archive.test', chain);
    const rpc = client(endpoint);
    const db = memoryDb();
    await expect(discover({ primary: rpc, archival: rpc, db }, 4, 'P', { gen: 1, frontierSlot: 500 }))
      .rejects.toThrow('archival history ended above the frontier');
    expect(db.builds[0].frontierSlot).toBeNull();
    expect(db.builds[0].discoveredAt).toBeNull();
  });

  it('a program whose only history is the frontier slot itself is fine', async () => {
    const chain = history(1);
    const { endpoint } = sigsEndpoint('https://archive.test', chain);
    const rpc = client(endpoint);
    const db = memoryDb();
    const result = await discover({ primary: rpc, archival: rpc, db }, 4, 'P', { gen: 1, frontierSlot: chain[0].slot });
    expect(result.found).toBe(1);
  });

  it('the frontier is only sent with the final enqueue, after every older signature is queued', async () => {
    const chain = history(2100);
    const { endpoint } = sigsEndpoint('https://archive.test', chain);
    const rpc = client(endpoint);
    const db = memoryDb();
    const calls: Array<{ n: number; final: unknown }> = [];
    const original = db.enqueue.bind(db);
    db.enqueue = async (program, gen, sigs, final = null) => {
      calls.push({ n: sigs.length, final });
      return original(program, gen, sigs, final);
    };
    await discover({ primary: rpc, archival: rpc, db }, 4, 'P', { gen: 1, frontierSlot: null });
    expect(calls.map((c) => c.n)).toEqual([1000, 1000, 100, 0]);
    expect(calls.slice(0, 3).every((c) => c.final === null)).toBe(true);
    expect(calls[3].final).toMatchObject({ frontier_slot: chain[0].slot, history_end: true });
  });

  it('fills a null blockTime with getBlockTime', async () => {
    const chain = history(3);
    chain[1].blockTime = null;
    const { endpoint } = sigsEndpoint('https://archive.test', chain);
    const rpc = client(endpoint);
    const db = memoryDb();
    await discover({ primary: rpc, archival: rpc, db }, 4, 'P', { gen: 1, frontierSlot: null });
    expect(endpoint.calls.filter((c) => c.method === 'getBlockTime')).toHaveLength(1);
    expect(db.pendingFor(4).every((p) => p.block_time.startsWith('2026'))).toBe(true);
  });
});
