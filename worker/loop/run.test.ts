// The run loop against a fake chain and the in-memory database.

import bs58 from 'bs58';
import { PROGRAMS } from '../../src/types/protocol.js';
import { RpcClient } from '../rpc/client.js';
import { fakeClock, fakeEndpoint, MemoryDb } from '../testing/fakeRpc.js';
import type { Snapshot } from '../state/snapshot.js';
import { runWorker, type WorkerOptions } from './run.js';

const PROGRAMDATA = bs58.encode(new Uint8Array(32).fill(7));

function programAccount(): { context: { slot: number }; value: { data: [string, string]; lamports: number; owner: string; executable: boolean } } {
  const data = new Uint8Array(36);
  data[0] = 2;
  data.set(bs58.decode(PROGRAMDATA), 4);
  return { context: { slot: 1 }, value: { data: [Buffer.from(data).toString('base64'), 'base64'], lamports: 1, owner: 'BPF', executable: true } };
}

function programdataHeader(slot: number) {
  const data = new Uint8Array(45);
  data[0] = 3;
  new DataView(data.buffer).setBigUint64(4, BigInt(slot), true);
  return { context: { slot: 1 }, value: { data: [Buffer.from(data).toString('base64'), 'base64'], lamports: 1, owner: 'BPF', executable: false } };
}

function fakeTx(programId: string, signature: string, slot: number) {
  return {
    slot,
    blockTime: 1_790_000_000 + slot,
    version: 0,
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: [bs58.encode(new Uint8Array(32).fill(1)), bs58.encode(new Uint8Array(32).fill(2)), programId],
        header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
        instructions: [{ programIdIndex: 2, accounts: [0, 1], data: bs58.encode(new Uint8Array([4])) }],
      },
    },
    meta: { err: null, fee: 5000, preBalances: [1, 1, 1], postBalances: [1, 1, 1], innerInstructions: [], loadedAddresses: { writable: [], readonly: [] } },
  };
}

interface ChainProgram {
  deployed: boolean;
  signatures: Array<{ signature: string; slot: number }>;
  missing?: Set<string>;
}

function chain(programs: Record<string, ChainProgram>) {
  const byId = new Map(Object.entries(programs));
  const findTx = (signature: string) => {
    for (const [id, program] of byId) {
      const hit = program.signatures.find((s) => s.signature === signature);
      if (hit) return program.missing?.has(signature) ? null : fakeTx(id, signature, hit.slot);
    }
    return null;
  };
  return fakeEndpoint('https://rpc.test', {
    getAccountInfo: (params) => {
      const address = params[0] as string;
      if (address === PROGRAMDATA) return programdataHeader(7);
      return byId.get(address)?.deployed ? programAccount() : { context: { slot: 1 }, value: null };
    },
    getSignaturesForAddress: (params) => {
      const program = byId.get(params[0] as string);
      const options = params[1] as { limit: number; before?: string };
      const list = [...(program?.signatures ?? [])].sort((a, b) => b.slot - a.slot)
        .map((s) => ({ ...s, blockTime: 1_790_000_000 + s.slot, err: null }));
      const start = options.before ? list.findIndex((s) => s.signature === options.before) + 1 : 0;
      return list.slice(start, start + options.limit);
    },
    getTransaction: (params) => findTx(params[0] as string),
  });
}

function db(keys: number[]) {
  return new MemoryDb(
    PROGRAMS.filter((p) => keys.includes(p.programKey)).map((p) => ({
      programKey: p.programKey, cluster: p.cluster, version: p.version, programId: p.programId, label: p.label,
      lastDeploySlot: 7, binarySha256: 'known', binaryKind: p.version === 1 ? 'v1-full' : 'v2-full',
    })),
  );
}

function sigs(prefix: string, count: number, from = 100) {
  return Array.from({ length: count }, (_, i) => ({ signature: `${prefix}${String(i).padStart(4, '0')}`, slot: from + i }));
}

const snapshot = async (): Promise<Snapshot> => ({
  slot: 99,
  fetchedAt: new Date().toISOString(),
  totals: { accounts: 0, wallets: 0 } as unknown as Snapshot['totals'],
  detail: { shards: [], feeRecords: [] },
});

function options(overrides: Partial<WorkerOptions> = {}): WorkerOptions {
  let t = 1_790_000_000_000;
  return {
    mode: 'incremental',
    program: null,
    cluster: 'all',
    budgetMs: 3_600_000,
    reserveMs: 0,
    retentionDays: 35,
    runId: 'run-1',
    parserVersion: 1,
    log: () => undefined,
    now: () => (t += 1),
    ...overrides,
  };
}

function lanes(endpoint: ReturnType<typeof fakeEndpoint>) {
  const rpc = new RpcClient({ url: endpoint.url, heavyRps: 1e6, lightRps: 1e6, clock: fakeClock(), fetchImpl: endpoint.fetch });
  return { mainnet: { primary: rpc, archival: rpc }, devnet: { primary: rpc, archival: rpc } };
}

const [V1M, V2M, V1D, V2D] = PROGRAMS.map((p) => p.programId);

describe('worker run', () => {
  it('a not-deployed program costs exactly one call and reports not_deployed', async () => {
    const endpoint = chain({ [V2M]: { deployed: false, signatures: [] } });
    const memory = db([2]);
    const result = await runWorker({ db: memory, lanes: lanes(endpoint), snapshot }, options({ program: 2 }));
    expect(endpoint.calls).toHaveLength(1);
    expect(endpoint.calls[0].method).toBe('getAccountInfo');
    expect(result.exitCode).toBe(0);
    expect(result.programs[0].status).toBe('not_deployed');
    expect(memory.reports[0].run.status).toBe('not_deployed');
  });

  it('backfills everything in batches of 20 and exits 0', async () => {
    const endpoint = chain({ [V2D]: { deployed: true, signatures: sigs('d', 45) } });
    const memory = db([4]);
    const result = await runWorker({ db: memory, lanes: lanes(endpoint), snapshot }, options({ program: 4 }));
    expect(result.exitCode).toBe(0);
    expect(memory.ingestCalls.map((c) => c.signatures.length)).toEqual([20, 20, 5]);
    expect(memory.pendingFor(4)).toHaveLength(0);
    expect(memory.builds[0]).toMatchObject({ backfillComplete: true, ingested: 45 });
    expect(result.programs[0]).toMatchObject({ status: 'ok', discovered: 45, ingested: 45 });
    expect(memory.heartbeats.at(-1)?.source).toBe('worker');
    // a second run fetches nothing old: one signatures call per program, no getTransaction
    const before = endpoint.calls.length;
    const second = await runWorker({ db: memory, lanes: lanes(endpoint), snapshot }, options({ program: 4, runId: 'run-2' }));
    const calls = endpoint.calls.slice(before).map((c) => c.method);
    expect(calls.filter((m) => m === 'getTransaction')).toHaveLength(0);
    expect(calls.filter((m) => m === 'getSignaturesForAddress')).toHaveLength(1);
    expect(second.programs[0]).toMatchObject({ queued: 0, ingested: 0, status: 'ok' });
  });

  it('round-robins batches across the programs of a lane', async () => {
    const endpoint = chain({ [V1D]: { deployed: true, signatures: sigs('a', 45) }, [V2D]: { deployed: true, signatures: sigs('b', 45, 500) } });
    const memory = db([3, 4]);
    await runWorker({ db: memory, lanes: lanes(endpoint), snapshot }, options({ cluster: 'devnet' }));
    expect(memory.ingestCalls.map((c) => c.program)).toEqual([3, 4, 3, 4, 3, 4]);
  });

  it('stops between batches when the budget is spent and reports lagging with progress', async () => {
    const endpoint = chain({ [V2D]: { deployed: true, signatures: sigs('d', 100) } });
    const memory = db([4]);
    let t = 0;
    const result = await runWorker({ db: memory, lanes: lanes(endpoint), snapshot },
      options({ program: 4, budgetMs: 100, reserveMs: 0, now: () => (t += 30) }));
    expect(memory.ingestCalls.length).toBeGreaterThan(0);
    expect(memory.pendingFor(4).length).toBeGreaterThan(0);
    expect(result.programs[0].status).toBe('lagging');
    expect(memory.reports[0].run.progress).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('a signature no endpoint serves is retried once per run and becomes a gap after 5 runs', async () => {
    const all = sigs('d', 3);
    const endpoint = chain({ [V2D]: { deployed: true, signatures: all, missing: new Set([all[1].signature]) } });
    const memory = db([4]);
    for (let run = 1; run <= 5; run += 1) {
      await runWorker({ db: memory, lanes: lanes(endpoint), snapshot }, options({ program: 4, runId: `run-${run}` }));
      expect(memory.markCalls.filter((c) => c.run === `run-${run}`)).toHaveLength(1);
    }
    expect(memory.gaps.has(all[1].signature)).toBe(true);
    expect(memory.pendingFor(4)).toHaveLength(0);
    expect(memory.builds[0].backfillComplete).toBe(true);
  });

  it('a transaction whose rows the database rejects does not hold back the queue; it becomes a gap after 5 runs', async () => {
    const all = sigs('d', 6);
    const endpoint = chain({ [V2D]: { deployed: true, signatures: all } });
    const memory = db([4]);
    const poison = all[1].signature;
    memory.rejectSignatures.add(poison);
    const first = await runWorker({ db: memory, lanes: lanes(endpoint), snapshot }, options({ program: 4, runId: 'run-1' }));
    // the batch was rejected, then retried one signature at a time: the 5 others are in
    expect(memory.rejectedCalls[0].signatures).toHaveLength(6);
    expect(memory.ingestCalls.flatMap((c) => c.signatures).sort()).toEqual(all.map((s) => s.signature).filter((s) => s !== poison));
    expect(memory.pendingFor(4).map((p) => p.signature)).toEqual([poison]);
    expect(memory.markCalls).toEqual([{ program: 4, signature: poison, run: 'run-1' }]);
    expect(first.programs[0]).toMatchObject({ ingested: 5, rejected: 1, status: 'lagging' });
    expect(first.programs[0].warnings.join(' ')).toContain('rejected by the database');
    expect(first.exitCode).toBe(0);
    for (let run = 2; run <= 5; run += 1) {
      await runWorker({ db: memory, lanes: lanes(endpoint), snapshot }, options({ program: 4, runId: `run-${run}` }));
    }
    expect(memory.gaps.has(poison)).toBe(true);
    expect(memory.pendingFor(4)).toHaveLength(0);
  });

  it('a rejection that is not about the data (auth, timeout) still fails the program without marking attempts', async () => {
    const endpoint = chain({ [V2D]: { deployed: true, signatures: sigs('d', 3) } });
    const memory = db([4]);
    memory.failIngestFor = 4;
    const result = await runWorker({ db: memory, lanes: lanes(endpoint), snapshot }, options({ program: 4 }));
    expect(result.programs[0].status).toBe('failed');
    expect(memory.markCalls).toHaveLength(0);
    expect(memory.pendingFor(4)).toHaveLength(3);
  });

  it('exit 1 when a program fails; other programs still progress', async () => {
    const endpoint = chain({ [V1D]: { deployed: true, signatures: sigs('a', 5) }, [V2D]: { deployed: true, signatures: sigs('b', 5, 500) } });
    const memory = db([3, 4]);
    memory.failIngestFor = 3;
    const result = await runWorker({ db: memory, lanes: lanes(endpoint), snapshot }, options({ cluster: 'devnet' }));
    expect(result.exitCode).toBe(1);
    expect(result.programs.find((p) => p.programKey === 3)?.status).toBe('failed');
    expect(result.programs.find((p) => p.programKey === 4)?.status).toBe('ok');
    expect(memory.pendingFor(4)).toHaveLength(0);
  });

  it('exit 1 when lk_verify reports a mismatch', async () => {
    const endpoint = chain({ [V2D]: { deployed: true, signatures: sigs('d', 2) } });
    const memory = db([4]);
    memory.verifyMismatches = 2;
    const result = await runWorker({ db: memory, lanes: lanes(endpoint), snapshot }, options({ program: 4 }));
    expect(result.exitCode).toBe(1);
    expect(result.programs[0].verify).toEqual({ mismatches: 2, daysChecked: 1 });
  });

  it('exit 2 when the schema is missing (PGRST202) or too old, before any RPC call', async () => {
    const endpoint = chain({ [V1M]: { deployed: true, signatures: [] } });
    const missing = db([1]);
    missing.missingSchema = true;
    const result = await runWorker({ db: missing, lanes: lanes(endpoint), snapshot }, options());
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain('apply supabase/migrations');
    const old = db([1]);
    old.schemaVersion = 0;
    const result2 = await runWorker({ db: old, lanes: lanes(endpoint), snapshot }, options());
    expect(result2.exitCode).toBe(2);
    expect(endpoint.calls).toHaveLength(0);
  });

  it('mode=rebuild starts a building generation, backfills it and promotes it once caught up', async () => {
    const endpoint = chain({ [V2D]: { deployed: true, signatures: sigs('d', 30) } });
    const memory = db([4]);
    await runWorker({ db: memory, lanes: lanes(endpoint), snapshot }, options({ program: 4 }));
    const result = await runWorker({ db: memory, lanes: lanes(endpoint), snapshot }, options({ program: 4, mode: 'rebuild', runId: 'run-2' }));
    expect(result.programs[0].promoted).toBe(2);
    expect(memory.programs[0].activeGen).toBe(2);
    expect(memory.builds.find((b) => b.gen === 2)).toMatchObject({ status: 'active', ingested: 30 });
  });
});
