// One worker run (spec §5.1):
//   per cluster lane (mainnet ‖ devnet, concurrently), per program, sequentially:
//     A deployment + binary   C state snapshot (before discovery)   B discovery into the queue
//   per lane: round-robin ingest batches of 20 until the budget (minus a reserve) is spent
//   per program: E retry gaps, P promote a caught-up building generation, R reparse (mode=reparse), F report
//   G compaction, lk_verify (R1) per live program, worker heartbeat; exit 1 on any failure or verify mismatch.

import { EXPECTED_DB_SCHEMA_VERSION } from '../../src/types/dashboard.js';
import type { DbProgram, LkDb, WorkerContext } from '../db/client.js';
import { DbError } from '../db/client.js';
import type { RpcClient } from '../rpc/client.js';
import { takeSnapshot, type Snapshot } from '../state/snapshot.js';
import { detectDeployment } from './deployment.js';
import { discover } from './discover.js';
import { emptyStats, ingestBatch, reparse, retryGaps, type IngestStats } from './ingest.js';

export type WorkerMode = 'incremental' | 'reparse' | 'rebuild' | 'verify';

export interface Lane {
  primary: RpcClient;
  archival: RpcClient;
}

export interface WorkerOptions {
  mode: WorkerMode;
  program: number | null;
  cluster: 'mainnet' | 'devnet' | 'all';
  budgetMs: number;
  reserveMs: number;
  retentionDays: number;
  runId: string;
  parserVersion: number;
  log: (line: string) => void;
  now: () => number;
}

export interface WorkerDeps {
  db: LkDb;
  lanes: Record<'mainnet' | 'devnet', Lane>;
  snapshot?: (rpc: RpcClient, programId: string, version: 1 | 2) => Promise<Snapshot>;
}

export interface ProgramOutcome {
  programKey: number;
  label: string;
  cluster: 'mainnet' | 'devnet';
  status: string;
  errors: string[];
  deployed: boolean;
  binaryKind: string | null;
  discovered: number;
  queued: number;
  ingested: number;
  attempted: number;
  failedFetches: number;
  convertedToGaps: number;
  gapsRepaired: number;
  reparsed: number;
  pending: number | null;
  warnings: string[];
  stateSlot: number | null;
  checks: unknown[];
  verify: { mismatches: number; daysChecked: number } | null;
  promoted: number | null;
}

export interface WorkerResult {
  exitCode: 0 | 1 | 2;
  message: string;
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  programs: ProgramOutcome[];
  compact: unknown;
  rpcCalls: Record<string, Record<string, number>>;
  rpcThrottles: Record<string, Record<string, number>>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isSchemaMissing(error: unknown): boolean {
  return error instanceof DbError && (error.code === 'PGRST202' || error.code === '42883' || error.status === 404);
}

function newOutcome(program: DbProgram): ProgramOutcome {
  return {
    programKey: program.programKey,
    label: program.label,
    cluster: program.cluster,
    status: 'idle',
    errors: [],
    deployed: false,
    binaryKind: program.binaryKind,
    discovered: 0,
    queued: 0,
    ingested: 0,
    attempted: 0,
    failedFetches: 0,
    convertedToGaps: 0,
    gapsRepaired: 0,
    reparsed: 0,
    pending: null,
    warnings: [],
    stateSlot: null,
    checks: [],
    verify: null,
    promoted: null,
  };
}

export async function runWorker(deps: WorkerDeps, options: WorkerOptions): Promise<WorkerResult> {
  const started = options.now();
  const startedAt = new Date(started).toISOString();
  const deadline = started + options.budgetMs;
  const log = options.log;
  const finish = (exitCode: 0 | 1 | 2, message: string, programs: ProgramOutcome[], compact: unknown = null): WorkerResult => {
    const finished = options.now();
    const rpcCalls: Record<string, Record<string, number>> = {};
    const rpcThrottles: Record<string, Record<string, number>> = {};
    for (const [cluster, lane] of Object.entries(deps.lanes)) {
      rpcCalls[`${cluster}:primary`] = { ...lane.primary.calls };
      rpcThrottles[`${cluster}:primary`] = { ...lane.primary.throttles };
      if (lane.archival !== lane.primary) {
        rpcCalls[`${cluster}:archival`] = { ...lane.archival.calls };
        rpcThrottles[`${cluster}:archival`] = { ...lane.archival.throttles };
      }
    }
    return {
      exitCode,
      message,
      runId: options.runId,
      startedAt,
      finishedAt: new Date(finished).toISOString(),
      durationMs: finished - started,
      programs,
      compact,
      rpcCalls,
      rpcThrottles,
    };
  };

  let ctx: WorkerContext;
  try {
    ctx = await deps.db.workerContext();
  } catch (error) {
    if (isSchemaMissing(error)) {
      return finish(2, 'database schema missing: apply supabase/migrations/20261002000100_lk_event_log.sql', []);
    }
    throw error;
  }
  if (!ctx || typeof ctx.schemaVersion !== 'number' || ctx.schemaVersion < EXPECTED_DB_SCHEMA_VERSION) {
    return finish(2, `database schema version ${ctx?.schemaVersion ?? 'none'} < ${EXPECTED_DB_SCHEMA_VERSION}: apply the migration`, []);
  }

  if (options.mode === 'rebuild') {
    if (options.program === null) throw new Error('mode=rebuild needs a program');
    const gen = await deps.db.startBuild(options.program, options.parserVersion);
    log(`[run] started building generation ${gen} for program ${options.program}`);
    ctx = await deps.db.workerContext();
  }

  const selected = ctx.programs.filter(
    (program) =>
      (options.cluster === 'all' || program.cluster === options.cluster) &&
      (options.program === null || program.programKey === options.program),
  );

  if (options.mode === 'verify') {
    const outcomes: ProgramOutcome[] = [];
    let mismatch = false;
    for (const program of selected) {
      const outcome = newOutcome(program);
      outcome.status = program.deployStatus;
      if (program.deployStatus === 'live') {
        const result = await deps.db.verify(program.programKey, program.activeGen);
        outcome.verify = { mismatches: result.mismatches, daysChecked: result.daysChecked };
        if (result.mismatches > 0) mismatch = true;
      }
      outcomes.push(outcome);
    }
    return finish(mismatch ? 1 : 0, mismatch ? 'lk_verify found mismatches' : 'verify ok', outcomes);
  }

  const snapshot = deps.snapshot ?? takeSnapshot;
  const byCluster = new Map<'mainnet' | 'devnet', DbProgram[]>();
  for (const program of selected) {
    const list = byCluster.get(program.cluster) ?? [];
    list.push(program);
    byCluster.set(program.cluster, list);
  }

  const lanes = [...byCluster.entries()].map(async ([cluster, programs]) => {
    const lane = deps.lanes[cluster];
    const outcomes = new Map<number, ProgramOutcome>();
    const stats = new Map<string, IngestStats>();
    const work: Array<{ program: DbProgram; gen: number }> = [];
    const ingestDeps = { primary: lane.primary, archival: lane.archival, db: deps.db, runId: options.runId, parserVersion: options.parserVersion };

    for (const program of programs) {
      const outcome = newOutcome(program);
      outcomes.set(program.programKey, outcome);
      // A: deployment and binary
      try {
        const result = await detectDeployment(lane.primary, lane.archival, deps.db, program, ctx.knownBinaries);
        if (!result.deployed) {
          outcome.status = 'not_deployed';
          log(`[${program.label}] not deployed (getAccountInfo returned null)`);
          continue;
        }
        outcome.deployed = true;
        outcome.binaryKind = result.deployment.kind ?? program.binaryKind;
      } catch (error) {
        outcome.errors.push(`deployment: ${errorText(error)}`);
        log(`[${program.label}] deployment check failed: ${errorText(error)}`);
        continue;
      }
      // C: state snapshot before discovery
      try {
        const snap = await snapshot(lane.primary, program.programId, program.version);
        await deps.db.writeState(program.programKey, snap.slot, snap.totals, snap.detail, snap.fetchedAt);
        outcome.stateSlot = snap.slot;
        log(`[${program.label}] state @${snap.slot}: ${snap.totals.accounts} accounts, ${snap.totals.wallets} wallets`);
      } catch (error) {
        outcome.errors.push(`state: ${errorText(error)}`);
        log(`[${program.label}] state snapshot failed: ${errorText(error)}`);
      }
      // B: discovery for the active build and a building one
      const builds = [...program.builds].sort((a, b) => (a.status === 'active' ? -1 : 1) - (b.status === 'active' ? -1 : 1));
      for (const build of builds) {
        try {
          const result = await discover({ primary: lane.primary, archival: lane.archival, db: deps.db, log }, program.programKey,
            program.programId, build);
          outcome.discovered += result.found;
          outcome.queued += result.queued;
        } catch (error) {
          outcome.errors.push(`discovery g${build.gen}: ${errorText(error)}`);
          log(`[${program.label}] discovery g${build.gen} failed: ${errorText(error)}`);
        }
        work.push({ program, gen: build.gen });
        stats.set(`${program.programKey}:${build.gen}`, emptyStats());
      }
    }

    // D: round-robin ingest until the budget minus the reserve is spent
    let rotation = [...work];
    while (rotation.length > 0 && options.now() < deadline - options.reserveMs) {
      const next: typeof rotation = [];
      for (const item of rotation) {
        if (options.now() >= deadline - options.reserveMs) {
          next.push(item);
          continue;
        }
        const itemStats = stats.get(`${item.program.programKey}:${item.gen}`) as IngestStats;
        try {
          const taken = await ingestBatch(ingestDeps, item.program.programKey, item.gen, itemStats);
          if (taken > 0) next.push(item);
        } catch (error) {
          outcomes.get(item.program.programKey)?.errors.push(`ingest g${item.gen}: ${errorText(error)}`);
          log(`[${item.program.label}] ingest g${item.gen} failed: ${errorText(error)}`);
        }
      }
      if (next.length === rotation.length && options.now() >= deadline - options.reserveMs) break;
      rotation = next;
    }

    for (const item of work) {
      const outcome = outcomes.get(item.program.programKey) as ProgramOutcome;
      const itemStats = stats.get(`${item.program.programKey}:${item.gen}`) as IngestStats;
      outcome.ingested += itemStats.ingested;
      outcome.attempted += itemStats.attempted;
      outcome.failedFetches += itemStats.failedFetches;
      outcome.convertedToGaps += itemStats.convertedToGaps;
      outcome.warnings.push(...itemStats.warnings);
    }

    // E: gaps, R: reparse
    for (const program of programs) {
      const outcome = outcomes.get(program.programKey) as ProgramOutcome;
      if (!outcome.deployed) continue;
      if (options.now() < deadline - options.reserveMs) {
        try {
          const gaps = await retryGaps(ingestDeps, program.programKey, program.activeGen, 10);
          outcome.gapsRepaired += gaps.repaired;
        } catch (error) {
          outcome.errors.push(`gaps: ${errorText(error)}`);
        }
      }
      if (options.mode === 'reparse' && options.now() < deadline - options.reserveMs) {
        try {
          const result = await reparse(ingestDeps, program.programKey, program.activeGen, deadline - options.reserveMs, options.now);
          outcome.reparsed += result.reparsed;
        } catch (error) {
          outcome.errors.push(`reparse: ${errorText(error)}`);
        }
      }
    }
    return { programs, outcomes };
  });

  const laneResults = await Promise.all(lanes);

  // P: promote building generations that caught up (one fresh context read)
  const promotable = laneResults.flatMap((lane) => lane.programs).filter((p) => p.builds.some((b) => b.status === 'building'));
  if (promotable.length > 0) {
    const fresh = await deps.db.workerContext();
    for (const program of promotable) {
      const current = fresh.programs.find((p) => p.programKey === program.programKey);
      const building = current?.builds.find((b) => b.status === 'building');
      const active = current?.builds.find((b) => b.status === 'active');
      if (!current || !building || !building.backfillComplete || building.pending > 0) continue;
      if (active?.discoveredAt && (!building.discoveredAt || building.discoveredAt < active.discoveredAt)) continue;
      try {
        await deps.db.promoteBuild(program.programKey, building.gen);
        const outcome = laneResults.flatMap((lane) => [...lane.outcomes.values()]).find((o) => o.programKey === program.programKey);
        if (outcome) outcome.promoted = building.gen;
        program.activeGen = building.gen;
        log(`[${program.label}] promoted generation ${building.gen}`);
      } catch (error) {
        log(`[${program.label}] promotion of g${building.gen} failed: ${errorText(error)}`);
      }
    }
  }

  // F: report every program
  const outcomes: ProgramOutcome[] = [];
  for (const lane of laneResults) {
    for (const program of lane.programs) {
      const outcome = lane.outcomes.get(program.programKey) as ProgramOutcome;
      const status = outcome.status === 'not_deployed' ? 'not_deployed' : outcome.errors.length > 0 ? 'failed' : 'ok';
      try {
        const report = await deps.db.reportRun(program.programKey, program.activeGen, {
          run_id: options.runId,
          started_at: startedAt,
          finished_at: new Date(options.now()).toISOString(),
          status,
          error: outcome.errors.length > 0 ? outcome.errors.join('; ').slice(0, 1900) : null,
          progress: outcome.ingested + outcome.convertedToGaps > 0,
          discovered: outcome.discovered,
          queued: outcome.queued,
          ingested: outcome.ingested,
          attempted: outcome.attempted,
          failed_fetches: outcome.failedFetches,
          gaps_converted: outcome.convertedToGaps,
          gaps_repaired: outcome.gapsRepaired,
          parse_warnings: outcome.warnings.length,
          state_slot: outcome.stateSlot,
          binary_kind: outcome.binaryKind,
        });
        outcome.status = report.status;
        outcome.pending = report.pending;
        outcome.checks = report.checks ?? [];
      } catch (error) {
        outcome.status = 'failed';
        outcome.errors.push(`report: ${errorText(error)}`);
      }
      outcomes.push(outcome);
    }
  }
  outcomes.sort((a, b) => a.programKey - b.programKey);

  // G: compaction, R1 verify, heartbeat
  let compact: unknown = null;
  let exitCode: 0 | 1 = outcomes.some((o) => o.status === 'failed') ? 1 : 0;
  try {
    compact = await deps.db.compact(options.retentionDays);
  } catch (error) {
    exitCode = 1;
    log(`[run] lk_compact failed: ${errorText(error)}`);
  }
  for (const outcome of outcomes) {
    if (!outcome.deployed) continue;
    const program = selected.find((p) => p.programKey === outcome.programKey) as DbProgram;
    try {
      const result = await deps.db.verify(outcome.programKey, program.activeGen);
      outcome.verify = { mismatches: result.mismatches, daysChecked: result.daysChecked };
      if (result.mismatches > 0) {
        exitCode = 1;
        log(`[${outcome.label}] lk_verify: ${result.mismatches} mismatches ${JSON.stringify(result.details).slice(0, 500)}`);
      }
    } catch (error) {
      exitCode = 1;
      outcome.errors.push(`verify: ${errorText(error)}`);
    }
  }
  const summary = {
    run_id: options.runId,
    mode: options.mode,
    exit_code: exitCode,
    programs: Object.fromEntries(outcomes.map((o) => [o.programKey, { status: o.status, ingested: o.ingested, pending: o.pending }])),
  };
  try {
    await deps.db.heartbeat('worker', summary);
  } catch (error) {
    exitCode = 1;
    log(`[run] heartbeat failed: ${errorText(error)}`);
  }
  const failed = outcomes.filter((o) => o.status === 'failed').map((o) => o.label);
  return finish(
    exitCode,
    exitCode === 0 ? 'ok' : failed.length > 0 ? `failed: ${failed.join(', ')}` : 'verification or compaction problem',
    outcomes,
    compact,
  );
}
