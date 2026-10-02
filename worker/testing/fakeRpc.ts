// Test doubles: a fake JSON-RPC endpoint (fetch-compatible), a no-wait clock, and an in-memory LkDb.

import type { Clock } from '../rpc/limiter.js';
import type { DbBuild, DbProgram, DiscoveryFinal, LkDb, QueuedSignature, RunReport, WorkerContext } from '../db/client.js';
import type { EventRow, PendingSignature } from '../types.js';

export type Handler = (params: unknown[]) => unknown;

export interface FakeEndpoint {
  url: string;
  fetch: typeof fetch;
  calls: Array<{ method: string; params: unknown[] }>;
}

export class RpcFailure {
  constructor(readonly code: number, readonly message: string) {}
}

/** A fetch() that answers JSON-RPC calls from per-method handlers. A handler may return a Response directly
 * (to fake HTTP errors), throw (network error), or return an RpcFailure (JSON-RPC error). */
export function fakeEndpoint(url: string, handlers: Record<string, Handler>): FakeEndpoint {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const impl = async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
    calls.push({ method: body.method, params: body.params });
    const handler = handlers[body.method];
    if (!handler) return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'no handler' } }));
    const result = handler(body.params);
    if (result instanceof Response) return result;
    if (result instanceof RpcFailure) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: result.code, message: result.message } }));
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  };
  return { url, fetch: impl as unknown as typeof fetch, calls };
}

export function fakeClock(start = 1_790_000_000_000): Clock & { slept: number[]; advance(ms: number): void } {
  let now = start;
  const slept: number[] = [];
  return {
    slept,
    now: () => now,
    sleep: async (ms: number) => {
      slept.push(ms);
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

interface MemBuild extends DbBuild {
  programKey: number;
}

/** A minimal in-memory LkDb: queue, ledger and builds, enough to test the worker loop. */
export class MemoryDb implements LkDb {
  programs: DbProgram[];
  builds: MemBuild[] = [];
  pendingRows = new Map<string, PendingSignature & { programKey: number; gen: number; lastRun: string | null }>();
  ledger = new Map<string, EventRow[]>();
  gaps = new Set<string>();
  reports: Array<{ program: number; run: RunReport }> = [];
  heartbeats: Array<{ source: string; detail: Record<string, unknown> }> = [];
  states: Array<{ program: number; slot: number }> = [];
  deployments: Array<{ program: number; status: string }> = [];
  ingestCalls: Array<{ program: number; signatures: string[]; replace: boolean }> = [];
  rejectedCalls: Array<{ program: number; signatures: string[] }> = [];
  markCalls: Array<{ program: number; signature: string; run: string }> = [];
  verifyMismatches = 0;
  schemaVersion = 1;
  missingSchema = false;
  failIngestFor: number | null = null;
  /** signatures whose rows the database rejects like Postgres does (HTTP 400, SQLSTATE 22003) */
  rejectSignatures = new Set<string>();

  constructor(programs: Array<Pick<DbProgram, 'programKey' | 'cluster' | 'version' | 'programId' | 'label'> & Partial<DbProgram>>) {
    this.programs = programs.map((p) => ({
      checksMode: 'enforce',
      deployStatus: 'unknown',
      programdataAddress: null,
      lastDeploySlot: null,
      binarySha256: null,
      binaryKind: null,
      activeGen: 1,
      lastRunStatus: 'idle',
      consecutiveFailures: 0,
      noProgressRuns: 0,
      builds: [],
      ...p,
    }));
    for (const p of this.programs) {
      this.builds.push({
        programKey: p.programKey, gen: 1, status: 'active', parserVersion: 1, frontierSlot: null, frontierSignature: null,
        frontierBlockTime: null, discoveredAt: null, historyEndReached: false, backfillComplete: false, ingested: 0,
        compactedBefore: null, pending: 0, gaps: 0,
      });
    }
  }

  private key(program: number, gen: number, signature: string) {
    return `${program}:${gen}:${signature}`;
  }

  pendingFor(program: number, gen = 1) {
    return [...this.pendingRows.values()].filter((p) => p.programKey === program && p.gen === gen);
  }

  async workerContext(): Promise<WorkerContext> {
    if (this.missingSchema) {
      const { DbError } = await import('../db/client.js');
      throw new DbError('lk_worker_context: HTTP 404 PGRST202', 'lk_worker_context', 404, 'PGRST202');
    }
    return {
      schemaVersion: this.schemaVersion,
      now: new Date().toISOString(),
      programs: this.programs.map((p) => ({
        ...p,
        builds: this.builds
          .filter((b) => b.programKey === p.programKey && b.status !== ('retired' as string))
          .map((b) => ({ ...b, pending: this.pendingFor(p.programKey, b.gen).length })),
      })),
      knownBinaries: [],
    };
  }

  async setDeployment(program: number, dep: { status: string; deploy_slot?: number; sha256?: string }) {
    this.deployments.push({ program, status: dep.status });
    const p = this.programs.find((x) => x.programKey === program) as DbProgram;
    p.deployStatus = dep.status as DbProgram['deployStatus'];
    if (dep.deploy_slot) p.lastDeploySlot = dep.deploy_slot;
    if (dep.sha256) p.binarySha256 = dep.sha256;
    return { status: dep.status, newDeploy: false };
  }

  async enqueue(program: number, gen: number, sigs: QueuedSignature[], final: DiscoveryFinal | null = null) {
    let queued = 0;
    for (const s of sigs) {
      const k = this.key(program, gen, s.signature);
      if (this.ledger.has(k) || this.pendingRows.has(k)) continue;
      this.pendingRows.set(k, { ...s, programKey: program, gen, attempts: 0, lastRun: null });
      queued += 1;
    }
    const build = this.builds.find((b) => b.programKey === program && b.gen === gen) as MemBuild;
    if (final) {
      if (final.frontier_slot !== null && (build.frontierSlot === null || final.frontier_slot > build.frontierSlot)) {
        build.frontierSlot = final.frontier_slot;
        build.frontierSignature = final.frontier_signature;
      }
      build.discoveredAt = final.discovered_at;
      build.historyEndReached ||= final.history_end;
    }
    if (build.historyEndReached && this.pendingFor(program, gen).length === 0) build.backfillComplete = true;
    return { received: sigs.length, queued, pending: this.pendingFor(program, gen).length };
  }

  async pending(program: number, gen: number, limit: number, runId: string) {
    return this.pendingFor(program, gen)
      .filter((p) => p.lastRun !== runId)
      .sort((a, b) => a.slot - b.slot)
      .slice(0, limit)
      .map(({ signature, slot, block_time, err, attempts }) => ({ signature, slot, block_time, err, attempts }));
  }

  async ingest(program: number, gen: number, events: EventRow[], signatures: string[], replace = false) {
    if (this.failIngestFor === program) throw new Error('simulated ingest failure');
    const poisoned = signatures.find((signature) => this.rejectSignatures.has(signature));
    if (poisoned) {
      this.rejectedCalls.push({ program, signatures });
      const { DbError } = await import('../db/client.js');
      throw new DbError('lk_ingest: HTTP 400 22003 value "4294967295" is out of range for type integer', 'lk_ingest', 400, '22003');
    }
    this.ingestCalls.push({ program, signatures, replace });
    let newSignatures = 0;
    for (const signature of signatures) {
      const k = this.key(program, gen, signature);
      if (!this.ledger.has(k)) newSignatures += 1;
      this.ledger.set(k, events.filter((e) => e.signature === signature));
      this.pendingRows.delete(k);
    }
    const build = this.builds.find((b) => b.programKey === program && b.gen === gen) as MemBuild;
    build.ingested += newSignatures;
    if (build.historyEndReached && this.pendingFor(program, gen).length === 0) build.backfillComplete = true;
    return { received: events.length, inserted: events.length, newSignatures, days: [] };
  }

  async markAttempt(program: number, gen: number, signature: string, runId: string) {
    this.markCalls.push({ program, signature, run: runId });
    const row = this.pendingRows.get(this.key(program, gen, signature));
    if (!row) return { gap: false, converted: false };
    if (row.lastRun !== runId) row.attempts += 1;
    row.lastRun = runId;
    if (row.attempts >= 5) {
      this.pendingRows.delete(this.key(program, gen, signature));
      this.ledger.set(this.key(program, gen, signature), []);
      this.gaps.add(signature);
      const build = this.builds.find((b) => b.programKey === program && b.gen === gen) as MemBuild;
      if (build.historyEndReached && this.pendingFor(program, gen).length === 0) build.backfillComplete = true;
      return { converted: true, attempts: row.attempts };
    }
    return { converted: false, attempts: row.attempts };
  }

  async openGaps() {
    return [];
  }

  async reparseCandidates() {
    return [];
  }

  async writeState(program: number, slot: number) {
    this.states.push({ program, slot });
  }

  async reportRun(program: number, _gen: number, run: RunReport) {
    this.reports.push({ program, run });
    const p = this.programs.find((x) => x.programKey === program) as DbProgram;
    const pending = this.pendingFor(program).length;
    let status: string = run.status;
    if (status === 'ok' || status === 'lagging') status = pending > 0 ? 'lagging' : 'ok';
    p.lastRunStatus = status;
    return { status, pending, consecutiveFailures: status === 'failed' ? 1 : 0, noProgressRuns: 0, checks: [] };
  }

  async compact() {
    return { sealedDays: 0, deletedEvents: 0 };
  }

  async verify() {
    return { mismatches: this.verifyMismatches, daysChecked: 1, details: [] };
  }

  async startBuild(program: number, parserVersion: number) {
    const gen = Math.max(...this.builds.filter((b) => b.programKey === program).map((b) => b.gen)) + 1;
    this.builds.push({
      programKey: program, gen, status: 'building', parserVersion, frontierSlot: null, frontierSignature: null,
      frontierBlockTime: null, discoveredAt: null, historyEndReached: false, backfillComplete: false, ingested: 0,
      compactedBefore: null, pending: 0, gaps: 0,
    });
    return gen;
  }

  async promoteBuild(program: number, gen: number) {
    for (const b of this.builds.filter((x) => x.programKey === program)) {
      if (b.status === 'active') (b as { status: string }).status = 'retired';
      if (b.gen === gen) b.status = 'active';
    }
    (this.programs.find((p) => p.programKey === program) as DbProgram).activeGen = gen;
    return { promoted: gen };
  }

  async heartbeat(source: string, detail: Record<string, unknown>) {
    this.heartbeats.push({ source, detail });
  }
}
