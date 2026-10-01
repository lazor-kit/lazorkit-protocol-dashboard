// Ingest (spec §5.5), retries and gaps (§5.6), reparse (§5.8).

import { parseContextFor } from '../chain/pdas.js';
import type { LkDb } from '../db/client.js';
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
  convertedToGaps: number;
  rows: number;
  warnings: string[];
}

export function emptyStats(): IngestStats {
  return { attempted: 0, ingested: 0, failedFetches: 0, convertedToGaps: 0, rows: 0, warnings: [] };
}

export interface IngestDeps {
  primary: RpcClient;
  archival: RpcClient;
  db: LkDb;
  runId: string;
  parserVersion: number;
}

function parseAll(programKey: number, parserVersion: number, items: Array<{ signature: string; blockTime: string; tx: RawTransaction }>) {
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
  const fetched: Array<{ signature: string; blockTime: string; tx: RawTransaction }> = [];
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
    await deps.db.ingest(programKey, gen, rows, fetched.map((item) => item.signature), false);
    stats.ingested += fetched.length;
    stats.rows += rows.length;
  }
  return batch.length;
}

/** Retries up to `limit` open gaps; a success replaces the kind=253 row and resolves the gap. */
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
    await deps.db.ingest(programKey, gen, rows, [gap.signature], true);
    repaired += 1;
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
    const fetched: Array<{ signature: string; blockTime: string; tx: RawTransaction }> = [];
    for (const signature of candidates) {
      const outcome = await fetchTransaction(deps.primary, deps.archival, signature);
      if (outcome.tx && outcome.tx.blockTime !== null) {
        fetched.push({ signature, blockTime: new Date(outcome.tx.blockTime * 1000).toISOString(), tx: outcome.tx });
      }
    }
    if (fetched.length === 0) break;
    const { rows } = parseAll(programKey, deps.parserVersion, fetched);
    await deps.db.ingest(programKey, gen, rows, fetched.map((item) => item.signature), true);
    reparsed += fetched.length;
    if (fetched.length < candidates.length) break; // unavailable ones stay candidates for a later run
  }
  return { reparsed };
}
