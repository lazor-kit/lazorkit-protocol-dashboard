// The worker's database client: POST {SUPABASE_URL}/rest/v1/rpc/lk_* with the service-role key. The lk schema
// itself is not exposed through PostgREST; every read and write goes through the public.lk_* functions.

import type { EventRow, PendingSignature } from '../types.js';

export class DbError extends Error {
  constructor(
    message: string,
    readonly fn: string,
    readonly status: number | null,
    readonly code: string | null,
  ) {
    super(message);
    this.name = 'DbError';
  }
}

export interface DbBuild {
  gen: number;
  status: 'active' | 'building';
  parserVersion: number;
  frontierSlot: number | null;
  frontierSignature: string | null;
  frontierBlockTime: string | null;
  discoveredAt: string | null;
  historyEndReached: boolean;
  backfillComplete: boolean;
  ingested: number;
  compactedBefore: string | null;
  pending: number;
  gaps: number;
}

export interface DbProgram {
  programKey: number;
  cluster: 'mainnet' | 'devnet';
  version: 1 | 2;
  programId: string;
  label: string;
  checksMode: 'enforce' | 'informational';
  deployStatus: 'unknown' | 'not_deployed' | 'live' | 'closed';
  programdataAddress: string | null;
  lastDeploySlot: number | null;
  binarySha256: string | null;
  binaryKind: string | null;
  activeGen: number;
  lastRunStatus: string;
  consecutiveFailures: number;
  noProgressRuns: number;
  builds: DbBuild[];
}

export interface WorkerContext {
  schemaVersion: number;
  now: string;
  programs: DbProgram[];
  knownBinaries: Array<{ sha256: string; elfSize: number; kind: string; label: string }>;
}

export interface Deployment {
  status: 'live' | 'not_deployed' | 'closed';
  programdata?: string;
  deploy_slot?: number;
  deployed_at?: string | null;
  upgrade_authority?: string | null;
  sha256?: string;
  elf_size?: number;
  kind?: string;
}

export interface QueuedSignature {
  signature: string;
  slot: number;
  block_time: string;
  err: unknown;
}

export interface DiscoveryFinal {
  frontier_slot: number | null;
  frontier_signature: string | null;
  frontier_block_time: string | null;
  discovered_at: string;
  history_end: boolean;
}

export interface RunReport {
  run_id: string;
  started_at: string;
  finished_at: string;
  status: 'ok' | 'lagging' | 'failed' | 'not_deployed';
  error: string | null;
  progress: boolean;
  [key: string]: unknown;
}

export interface LkDb {
  workerContext(): Promise<WorkerContext>;
  setDeployment(program: number, dep: Deployment): Promise<{ status: string; newDeploy: boolean }>;
  enqueue(program: number, gen: number, sigs: QueuedSignature[], final?: DiscoveryFinal | null): Promise<{ received: number; queued: number; pending: number }>;
  pending(program: number, gen: number, limit: number, runId: string): Promise<PendingSignature[]>;
  ingest(program: number, gen: number, events: EventRow[], signatures: string[], replace?: boolean): Promise<{ received: number; inserted: number; newSignatures: number; days: string[] }>;
  markAttempt(program: number, gen: number, signature: string, runId: string, error: string): Promise<{ converted?: boolean; attempts?: number; gap?: boolean }>;
  openGaps(program: number, gen: number, limit: number): Promise<PendingSignature[]>;
  reparseCandidates(program: number, gen: number, parserVersion: number, limit: number): Promise<string[]>;
  writeState(program: number, slot: number, totals: unknown, detail: unknown, fetchedAt: string): Promise<void>;
  reportRun(program: number, gen: number, run: RunReport): Promise<{ status: string; pending: number; consecutiveFailures: number; noProgressRuns: number; checks: unknown[] }>;
  compact(retentionDays: number): Promise<unknown>;
  verify(program: number, gen: number): Promise<{ mismatches: number; daysChecked: number; details: unknown[] }>;
  startBuild(program: number, parserVersion: number): Promise<number>;
  promoteBuild(program: number, gen: number): Promise<unknown>;
  heartbeat(source: string, detail: Record<string, unknown>): Promise<void>;
}

function isJwt(key: string): boolean {
  return key.split('.').length === 3;
}

export class PostgrestLkDb implements LkDb {
  private readonly base: string;

  constructor(
    url: string,
    private readonly key: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = url.replace(/\/+$/, '');
  }

  async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const headers: Record<string, string> = {
      apikey: this.key,
      'content-type': 'application/json',
      accept: 'application/json',
    };
    // Legacy JWT keys go in both headers; new sb_secret_ keys only in apikey (the gateway mints the JWT).
    if (isJwt(this.key)) headers.authorization = `Bearer ${this.key}`;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.base}/rest/v1/rpc/${fn}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(args),
        });
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
        continue;
      }
      const text = await response.text();
      if (!response.ok) {
        let code: string | null = null;
        let message = text.slice(0, 500);
        try {
          const body = JSON.parse(text) as { code?: string; message?: string; details?: string; hint?: string };
          code = body.code ?? null;
          message = [body.message, body.details, body.hint].filter(Boolean).join(' | ') || message;
        } catch {
          // not JSON
        }
        if (response.status >= 500 && response.status !== 500 && attempt < 2) {
          lastError = new DbError(`${fn}: HTTP ${response.status} ${message}`, fn, response.status, code);
          await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
          continue;
        }
        throw new DbError(`${fn}: HTTP ${response.status} ${code ?? ''} ${message}`.trim(), fn, response.status, code);
      }
      return (text ? JSON.parse(text) : null) as T;
    }
    throw new DbError(`${fn}: ${lastError instanceof Error ? lastError.message : String(lastError)}`, fn, null, null);
  }

  workerContext() {
    return this.rpc<WorkerContext>('lk_worker_context', {});
  }

  setDeployment(program: number, dep: Deployment) {
    return this.rpc<{ status: string; newDeploy: boolean }>('lk_set_deployment', { p_program: program, p_dep: dep });
  }

  enqueue(program: number, gen: number, sigs: QueuedSignature[], final: DiscoveryFinal | null = null) {
    return this.rpc<{ received: number; queued: number; pending: number }>('lk_enqueue', {
      p_program: program,
      p_gen: gen,
      p_sigs: sigs,
      p_final: final,
    });
  }

  pending(program: number, gen: number, limit: number, runId: string) {
    return this.rpc<PendingSignature[]>('lk_pending', { p_program: program, p_gen: gen, p_limit: limit, p_run: runId });
  }

  ingest(program: number, gen: number, events: EventRow[], signatures: string[], replace = false) {
    return this.rpc<{ received: number; inserted: number; newSignatures: number; days: string[] }>('lk_ingest', {
      p_program: program,
      p_gen: gen,
      p_events: events,
      p_signatures: signatures,
      p_replace: replace,
    });
  }

  markAttempt(program: number, gen: number, signature: string, runId: string, error: string) {
    return this.rpc<{ converted?: boolean; attempts?: number; gap?: boolean }>('lk_mark_attempt', {
      p_program: program,
      p_gen: gen,
      p_signature: signature,
      p_run: runId,
      p_error: error,
    });
  }

  openGaps(program: number, gen: number, limit: number) {
    return this.rpc<PendingSignature[]>('lk_open_gaps', { p_program: program, p_gen: gen, p_limit: limit });
  }

  reparseCandidates(program: number, gen: number, parserVersion: number, limit: number) {
    return this.rpc<string[]>('lk_reparse_candidates', {
      p_program: program,
      p_gen: gen,
      p_parser_version: parserVersion,
      p_limit: limit,
    });
  }

  async writeState(program: number, slot: number, totals: unknown, detail: unknown, fetchedAt: string) {
    await this.rpc('lk_write_state', {
      p_program: program,
      p_slot: slot,
      p_totals: totals,
      p_detail: detail,
      p_fetched_at: fetchedAt,
    });
  }

  reportRun(program: number, gen: number, run: RunReport) {
    return this.rpc<{ status: string; pending: number; consecutiveFailures: number; noProgressRuns: number; checks: unknown[] }>(
      'lk_report_run',
      { p_program: program, p_gen: gen, p_run: run },
    );
  }

  compact(retentionDays: number) {
    return this.rpc<unknown>('lk_compact', { p_retention_days: retentionDays });
  }

  verify(program: number, gen: number) {
    return this.rpc<{ mismatches: number; daysChecked: number; details: unknown[] }>('lk_verify', {
      p_program: program,
      p_gen: gen,
    });
  }

  startBuild(program: number, parserVersion: number) {
    return this.rpc<number>('lk_start_build', { p_program: program, p_parser_version: parserVersion });
  }

  promoteBuild(program: number, gen: number) {
    return this.rpc<unknown>('lk_promote_build', { p_program: program, p_gen: gen });
  }

  async heartbeat(source: string, detail: Record<string, unknown>) {
    await this.rpc('lk_heartbeat', { p_source: source, p_detail: detail });
  }
}
