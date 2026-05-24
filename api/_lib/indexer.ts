import { Connection } from '@solana/web3.js';
import { type ClusterId, programIdForCluster } from '../../src/solana/shared';
import {
  getBackfillDays,
  getIndexerBackfillMaxPages,
  getIndexerMaxSignatures,
  getIndexerParseDelayMs,
  rpcUrlForCluster,
} from './env';
import { SupabaseRestClient, type ProtocolTransactionRow } from './database';
import { parseLazorKitTransaction } from './transactionParser';

export interface IndexerRunResult {
  cluster: ClusterId;
  fetchedSignatures: number;
  backfillFetchedSignatures: number;
  indexedTransactions: number;
  skippedTransactions: number;
  warnings: string[];
  lastSeenSignature: string | null;
  lastIndexedSlot: number | null;
  lastIndexedAt: string | null;
  backfillComplete: boolean;
}

export async function runIndexer(
  cluster: ClusterId,
  db = new SupabaseRestClient(),
): Promise<IndexerRunResult> {
  const connection = new Connection(rpcUrlForCluster(cluster), 'confirmed');
  const programId = programIdForCluster(cluster);
  const cursor = await db.getCursor(cluster);
  const indexerState = await db.getIndexerState(cluster);
  const maxSignatures = getIndexerMaxSignatures();
  const maxBackfillPages = getIndexerBackfillMaxPages();
  const parseDelayMs = getIndexerParseDelayMs();
  const backfillDays = getBackfillDays();
  const backfillCutoffMs = Date.now() - backfillDays * 24 * 60 * 60 * 1000;

  const newestSignatures = await connection.getSignaturesForAddress(programId, {
    limit: maxSignatures,
    until: cursor?.last_seen_signature ?? undefined,
  });

  const filteredNewestSignatures = filterSignaturesWithinBackfillWindow(
    newestSignatures,
    backfillCutoffMs,
  );
  const rows: ProtocolTransactionRow[] = [];
  const warnings: string[] = [];
  const newestPage = await parseSignatureBatch(
    cluster,
    connection,
    filteredNewestSignatures,
    parseDelayMs,
  );
  rows.push(...newestPage.rows);
  warnings.push(...newestPage.warnings);

  let skippedTransactions = newestPage.skippedTransactions;
  await db.upsertProtocolTransactions(dedupeProtocolTransactionRows(rows));

  const oldestIndexed = await db.getOldestIndexedTransaction(cluster);
  const backfillAlreadyComplete =
    indexerState?.backfillComplete === true &&
    indexerState.backfillDays >= backfillDays;
  const shouldBackfill =
    !backfillAlreadyComplete &&
    oldestIndexed !== null &&
    new Date(oldestIndexed.block_time).getTime() > backfillCutoffMs;
  const backfill = await runBackfillPages({
    cluster,
    connection,
    programId,
    beforeSignature:
      indexerState?.backfillBeforeSignature ?? oldestIndexed?.signature ?? null,
    shouldBackfill,
    maxSignatures,
    maxBackfillPages,
    parseDelayMs,
    backfillCutoffMs,
    db,
  });
  skippedTransactions += backfill.skippedTransactions;
  warnings.push(...backfill.warnings);

  const newest = newestSignatures[0];
  const lastSeenSignature = newest?.signature ?? cursor?.last_seen_signature ?? null;
  const lastIndexedSlot = newest?.slot ?? cursor?.last_indexed_slot ?? null;
  const lastIndexedAt = new Date().toISOString();
  const shouldRecordRun = Boolean(newest || cursor || backfill.fetchedSignatures > 0);
  if (shouldRecordRun) {
    await db.upsertCursor({
      cluster,
      last_seen_signature: lastSeenSignature,
      last_indexed_slot: lastIndexedSlot,
      last_indexed_at: lastIndexedAt,
    });
  }
  if (shouldBackfill || backfillAlreadyComplete) {
    await db.upsertIndexerState(cluster, {
      backfillBeforeSignature: backfill.nextBeforeSignature,
      backfillComplete: backfill.complete,
      backfillDays,
      backfillUpdatedAt: lastIndexedAt,
    });
  }

  return {
    cluster,
    fetchedSignatures: newestSignatures.length + backfill.fetchedSignatures,
    backfillFetchedSignatures: backfill.fetchedSignatures,
    indexedTransactions: rows.length + backfill.indexedTransactions,
    skippedTransactions,
    warnings,
    lastSeenSignature,
    lastIndexedSlot,
    lastIndexedAt: shouldRecordRun ? lastIndexedAt : null,
    backfillComplete: backfill.complete,
  };
}

async function runBackfillPages({
  cluster,
  connection,
  programId,
  beforeSignature,
  shouldBackfill,
  maxSignatures,
  maxBackfillPages,
  parseDelayMs,
  backfillCutoffMs,
  db,
}: {
  cluster: ClusterId;
  connection: Connection;
  programId: ReturnType<typeof programIdForCluster>;
  beforeSignature: string | null;
  shouldBackfill: boolean;
  maxSignatures: number;
  maxBackfillPages: number;
  parseDelayMs: number;
  backfillCutoffMs: number;
  db: SupabaseRestClient;
}): Promise<{
  fetchedSignatures: number;
  indexedTransactions: number;
  skippedTransactions: number;
  warnings: string[];
  complete: boolean;
  nextBeforeSignature: string | null;
}> {
  if (!shouldBackfill || !beforeSignature) {
    return {
      fetchedSignatures: 0,
      indexedTransactions: 0,
      skippedTransactions: 0,
      warnings: [],
      complete: true,
      nextBeforeSignature: beforeSignature,
    };
  }

  let before = beforeSignature;
  let fetchedSignatures = 0;
  let indexedTransactions = 0;
  let skippedTransactions = 0;
  const warnings: string[] = [];
  let nextBeforeSignature: string | null = before;

  for (let page = 0; page < maxBackfillPages; page += 1) {
    const signatures = await connection.getSignaturesForAddress(programId, {
      limit: maxSignatures,
      before,
    });
    fetchedSignatures += signatures.length;

    const filteredSignatures = filterSignaturesWithinBackfillWindow(
      signatures,
      backfillCutoffMs,
    );
    const parsed = await parseSignatureBatch(
      cluster,
      connection,
      filteredSignatures,
      parseDelayMs,
    );
    indexedTransactions += parsed.rows.length;
    skippedTransactions += parsed.skippedTransactions;
    warnings.push(...parsed.warnings);
    await db.upsertProtocolTransactions(dedupeProtocolTransactionRows(parsed.rows));

    const reachedCutoff =
      signatures.length === 0 || filteredSignatures.length < signatures.length;
    if (reachedCutoff) {
      return {
        fetchedSignatures,
        indexedTransactions,
        skippedTransactions,
        warnings,
        complete: true,
        nextBeforeSignature,
      };
    }

    const nextBefore = signatures.at(-1)?.signature;
    if (!nextBefore || nextBefore === before) {
      break;
    }
    before = nextBefore;
    nextBeforeSignature = nextBefore;
  }

  return {
    fetchedSignatures,
    indexedTransactions,
    skippedTransactions,
    warnings,
    complete: false,
    nextBeforeSignature,
  };
}

async function parseSignatureBatch(
  cluster: ClusterId,
  connection: Connection,
  signatures: Awaited<ReturnType<Connection['getSignaturesForAddress']>>,
  parseDelayMs = getIndexerParseDelayMs(),
): Promise<{
  rows: ProtocolTransactionRow[];
  skippedTransactions: number;
  warnings: string[];
}> {
  const rows: ProtocolTransactionRow[] = [];
  const warnings: string[] = [];
  let skippedTransactions = 0;

  for (const item of signatures) {
    let tx = null;
    try {
      tx = await connection.getParsedTransaction(item.signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
    } catch (error) {
      warnings.push(`${item.signature}: ${formatFetchError(error)}`);
      skippedTransactions += 1;
      await sleep(parseDelayMs);
      continue;
    }

    const parsed = parseLazorKitTransaction(cluster, item.signature, tx);
    warnings.push(
      ...parsed.warnings.map((warning) => `${item.signature}: ${warning}`),
    );
    if (parsed.row) {
      rows.push(parsed.row);
    } else {
      skippedTransactions += 1;
    }
    await sleep(parseDelayMs);
  }

  return { rows, skippedTransactions, warnings };
}

function formatFetchError(error: unknown): string {
  if (!(error instanceof Error)) return 'Transaction fetch failed';
  const firstLine = error.message.split('\n')[0] ?? error.message;
  return `Transaction fetch failed: ${firstLine.slice(0, 180)}`;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function filterSignaturesWithinBackfillWindow(
  signatures: Awaited<ReturnType<Connection['getSignaturesForAddress']>>,
  backfillCutoffMs: number,
) {
  return signatures.filter(
    (item) =>
      typeof item.blockTime !== 'number' ||
      item.blockTime * 1000 >= backfillCutoffMs,
  );
}

export function dedupeProtocolTransactionRows(
  rows: readonly ProtocolTransactionRow[],
): ProtocolTransactionRow[] {
  const byKey = new Map<string, ProtocolTransactionRow>();
  for (const row of rows) {
    byKey.set(`${row.cluster}:${row.signature}`, row);
  }
  return [...byKey.values()];
}
