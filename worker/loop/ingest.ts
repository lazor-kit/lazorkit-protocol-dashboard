// Ingest (spec §5.5), retries and gaps (§5.6), reparse (§5.8).

import { parseContextFor } from '../chain/pdas.js';
import { DbError, type LkDb } from '../db/client.js';
import { parseTransaction } from '../parse/transaction.js';
import { isMissingHistoryError, RpcError, type RpcClient } from '../rpc/client.js';
import type { EventRow, PendingSignature, RawTransaction } from '../types.js';

export const BATCH_SIZE = 20;

export interface FetchOutcome {
  tx: RawTransaction | null;
  error: string | null;
}

const TX_OPTIONS = { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'finalized' } as const;

function reason(error: unknown): string {
  if (error instanceof RpcError) {
    if (error.code === -32015) return 'unsupported_tx_version';
    if (error.code !== null) return `rpc_error:${error.code}`;
    if (error.httpStatus !== null) return `rpc_error:http_${error.httpStatus}`;
    return 'rpc_error:network';
  }
  return `error:${error instanceof Error ? error.message.slice(0, 120) : String(error)}`;
}

/** getTransaction on the primary endpoint, then on the archival endpoint (null, -32007/-32009, timeout, 5xx). */
export async function fetchTransaction(primary: RpcClient, archival: RpcClient, signature: string): Promise<FetchOutcome> {
  let lastError: string | null = null;
  const endpoints = primary === archival ? [primary] : [primary, archival];
  for (const endpoint of endpoints) {
    try {
      const tx = await endpoint.call<RawTransaction | null>('getTransaction', [signature, TX_OPTIONS]);
      if (tx) return { tx, error: null };
      lastError = 'not_found_on_any_endpoint';
    } catch (error) {
      // a future transaction version: no endpoint will serve it to this client
      if (error instanceof RpcError && error.code === -32015) return { tx: null, error: reason(error) };
      lastError = isMissingHistoryError(error) ? 'not_found_on_any_endpoint' : reason(error);
    }
  }
  return { tx: null, error: lastError ?? 'not_found_on_any_endpoint' };
}

export interface IngestStats {
  attempted: number;
  ingested: number;
  failedFetches: number;
  /** signatures whose rows the database rejected (retried in later runs, a gap after 5) */
  rejected: number;
  convertedToGaps: number;
  rows: number;
  warnings: string[];
}

export function emptyStats(): IngestStats {
  return { attempted: 0, ingested: 0, failedFetches: 0, rejected: 0, convertedToGaps: 0, rows: 0, warnings: [] };
}

/**
 * The database refused the rows themselves: a SQLSTATE of class 22 (data exception, e.g. 22003 a value out of
 * range) or 23 (integrity constraint), which PostgREST answers with HTTP 400 (409 for 23503 / 23505). Sending the
 * same rows again can never succeed, unlike a timeout, a 5xx or an auth error, which are not per-signature and
 * keep failing the program as before.
 */
export function isDataRejection(error: unknown): error is DbError {
  return error instanceof DbError && (error.status === 400 || error.status === 409) && /^2[23]/.test(error.code ?? '');
}

export interface IngestDeps {
  primary: RpcClient;
  archival: RpcClient;
  db: LkDb;
  runId: string;
  parserVersion: number;
}

type Fetched = { signature: string; blockTime: string; tx: RawTransaction };

/**
 * lk_ingest for one batch. If the database rejects the batch's data, the signatures are ingested one at a time so
 * one bad transaction cannot hold back the rest of the queue (every newer signature of the program would otherwise
 * wait behind it forever); `onRejected` handles a signature still rejected on its own. Returns the ingested
 * signatures and their row count.
 */
async function ingestIsolating(
  deps: IngestDeps,
  programKey: number,
  gen: number,
  rows: EventRow[],
  signatures: string[],
  replace: boolean,
  onRejected: (signature: string, error: DbError) => Promise<void>,
): Promise<{ ingested: string[]; rows: number }> {
  try {
    await deps.db.ingest(programKey, gen, rows, signatures, replace);
    return { ingested: signatures, rows: rows.length };
  } catch (error) {
    if (!isDataRejection(error)) throw error;
  }
  const ingested: string[] = [];
  let count = 0;
  for (const signature of signatures) {
    const own = rows.filter((row) => row.signature === signature);
    try {
      await deps.db.ingest(programKey, gen, own, [signature], replace);
      ingested.push(signature);
      count += own.length;
    } catch (error) {
      if (!isDataRejection(error)) throw error;
      await onRejected(signature, error);
    }
  }
  return { ingested, rows: count };
}

function parseAll(programKey: number, parserVersion: number, items: Fetched[]) {
  const ctx = parseContextFor(programKey, parserVersion);
  const rows: EventRow[] = [];
  const warnings: string[] = [];
  for (const item of items) {
    const result = parseTransaction(item.tx, ctx, item.signature, item.blockTime);
    // the ledger is keyed by the queued signature, which is the transaction id (first signature)
    for (const row of result.rows) row.signature = item.signature;
    rows.push(...result.rows);
    warnings.push(...result.warnings);
  }
  return { rows, warnings };
}

/** One batch of up to BATCH_SIZE pending signatures, oldest first; each signature is tried once per run. */
export async function ingestBatch(deps: IngestDeps, programKey: number, gen: number, stats: IngestStats): Promise<number> {
  const batch = await deps.db.pending(programKey, gen, BATCH_SIZE, deps.runId);
  if (batch.length === 0) return 0;
  const fetched: Fetched[] = [];
  for (const item of batch) {
    stats.attempted += 1;
    const outcome = await fetchTransaction(deps.primary, deps.archival, item.signature);
    if (outcome.tx) {
      fetched.push({ signature: item.signature, blockTime: item.block_time, tx: outcome.tx });
    } else {
      stats.failedFetches += 1;
      const mark = await deps.db.markAttempt(programKey, gen, item.signature, deps.runId, outcome.error ?? 'unknown');
      if (mark.converted) stats.convertedToGaps += 1;
    }
  }
  if (fetched.length > 0) {
    const { rows, warnings } = parseAll(programKey, deps.parserVersion, fetched);
    stats.warnings.push(...warnings);
    // A signature rejected on its own counts as a failed attempt: retried in later runs, a gap after 5 (like a
    // transaction no endpoint serves).
    const result = await ingestIsolating(deps, programKey, gen, rows, fetched.map((item) => item.signature), false,
      async (signature, error) => {
        stats.rejected += 1;
        stats.warnings.push(`${signature}: rows rejected by the database (${error.message.slice(0, 200)}); retried next run, a gap after 5 runs`);
        const mark = await deps.db.markAttempt(programKey, gen, signature, deps.runId, `ingest_rejected:${error.code ?? 'unknown'}`);
        if (mark.converted) stats.convertedToGaps += 1;
      });
    stats.ingested += result.ingested.length;
    stats.rows += result.rows;
  }
  return batch.length;
}

/** Retries up to `limit` open gaps; a success replaces the kind=253 row and resolves the gap. A gap whose rows the
 * database still rejects stays open (its attempt is counted) instead of failing the program. */
export async function retryGaps(deps: IngestDeps, programKey: number, gen: number, limit: number): Promise<{ tried: number; repaired: number }> {
  const gaps: PendingSignature[] = await deps.db.openGaps(programKey, gen, limit);
  let repaired = 0;
  for (const gap of gaps) {
    const outcome = await fetchTransaction(deps.primary, deps.archival, gap.signature);
    if (!outcome.tx) {
      await deps.db.markAttempt(programKey, gen, gap.signature, deps.runId, outcome.error ?? 'unknown');
      continue;
    }
    const { rows } = parseAll(programKey, deps.parserVersion, [{ signature: gap.signature, blockTime: gap.block_time, tx: outcome.tx }]);
    try {
      await deps.db.ingest(programKey, gen, rows, [gap.signature], true);
      repaired += 1;
    } catch (error) {
      if (!isDataRejection(error)) throw error;
      await deps.db.markAttempt(programKey, gen, gap.signature, deps.runId, `ingest_rejected:${error.code ?? 'unknown'}`);
    }
  }
  return { tried: gaps.length, repaired };
}

/** Re-fetches and re-ingests (replace) signatures parsed by an older PARSER_VERSION, on unsealed days. */
export async function reparse(
  deps: IngestDeps,
  programKey: number,
  gen: number,
  deadline: number,
  now: () => number,
): Promise<{ reparsed: number }> {
  let reparsed = 0;
  while (now() < deadline) {
    const candidates = await deps.db.reparseCandidates(programKey, gen, deps.parserVersion, BATCH_SIZE);
    if (candidates.length === 0) break;
    const fetched: Fetched[] = [];
    for (const signature of candidates) {
      const outcome = await fetchTransaction(deps.primary, deps.archival, signature);
      if (outcome.tx && outcome.tx.blockTime !== null) {
        fetched.push({ signature, blockTime: new Date(outcome.tx.blockTime * 1000).toISOString(), tx: outcome.tx });
      }
    }
    if (fetched.length === 0) break;
    const { rows } = parseAll(programKey, deps.parserVersion, fetched);
    const result = await ingestIsolating(deps, programKey, gen, rows, fetched.map((item) => item.signature), true,
      async () => undefined);
    reparsed += result.ingested.length;
    // unavailable or rejected ones keep their old rows and stay candidates for a later run
    if (result.ingested.length < candidates.length) break;
  }
  return { reparsed };
}
