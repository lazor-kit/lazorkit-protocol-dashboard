import { Connection, type SignaturesForAddressOptions } from '@solana/web3.js';
import { type ClusterId } from '../../src/solana/shared.js';
import { programIdForCluster } from '../../src/solana/programId.js';
import {
  getBackfillDays,
  getIndexerBackfillMaxPages,
  getIndexerMaxSignatures,
  getIndexerMaxRuntimeMs,
  getIndexerParseDelayMs,
  rpcUrlForCluster,
} from './env.js';
import {
  SupabaseRestClient,
  type IndexedTransactionBoundary,
  type IndexerState,
  type ProtocolTransactionRow,
} from './database.js';
import { getCachedProtocolStats } from './protocolStats.js';
import { parseLazorKitTransaction } from './transactionParser.js';

export interface IndexerRunResult {
  cluster: ClusterId;
  fetchedSignatures: number;
  backfillFetchedSignatures: number;
  indexedTransactions: number;
  skippedTransactions: number;
  warnings: string[];
  warningsCount: number;
  lastSeenSignature: string | null;
  lastIndexedSlot: number | null;
  lastIndexedAt: string | null;
  backfillComplete: boolean;
  oldestIndexedAt: string | null;
  newestIndexedAt: string | null;
  runStatus: IndexerState['lastRunStatus'];
  lastRunError: string | null;
}

export async function runIndexer(
  cluster: ClusterId,
  db = new SupabaseRestClient(),
): Promise<IndexerRunResult> {
  const runStartedAt = new Date();
  const runStartedIso = runStartedAt.toISOString();
  const maxRuntimeMs = getIndexerMaxRuntimeMs();
  const deadlineMs = runStartedAt.getTime() + maxRuntimeMs;
  const connection = new Connection(rpcUrlForCluster(cluster), 'confirmed');
  const programId = programIdForCluster(cluster);
  const cursor = await db.getCursor(cluster);
  const indexerState = await db.getIndexerState(cluster);
  const maxSignatures = getIndexerMaxSignatures();
  const maxBackfillPages = getIndexerBackfillMaxPages();
  const parseDelayMs = getIndexerParseDelayMs();
  const backfillDays = getBackfillDays();
  const backfillCutoffMs = Date.now() - backfillDays * 24 * 60 * 60 * 1000;

  const warnings: string[] = [];
  await db.upsertIndexerState(
    cluster,
    mergeIndexerState(indexerState, {
      lastRunStartedAt: runStartedIso,
      lastRunCompletedAt: null,
      lastRunStatus: 'running',
      lastRunError: null,
      lastRunWarningsCount: 0,
      backfillDays,
    }),
  );

  try {
    if (isPastDeadline(deadlineMs)) {
      warnings.push('Indexer runtime budget reached before fetching signatures');
    }

    const newestSignatures = isPastDeadline(deadlineMs)
      ? []
      : await getSignaturesWithRetry(connection, programId, {
          limit: maxSignatures,
          until: cursor?.last_seen_signature ?? undefined,
        });

    const filteredNewestSignatures = filterSignaturesWithinBackfillWindow(
      newestSignatures,
      backfillCutoffMs,
    );
    const newestPage = await parseSignatureBatch(
      cluster,
      connection,
      filteredNewestSignatures,
      parseDelayMs,
      deadlineMs,
    );
    warnings.push(...newestPage.warnings);
    if (newestPage.deadlineReached) {
      warnings.push('Indexer runtime budget reached while parsing newest page');
    }

    let skippedTransactions = newestPage.skippedTransactions;
    const newestIndexedTransactions = await writeParsedRows(
      cluster,
      db,
      newestPage.rows,
    );

    const metricBoundariesBeforeBackfill = await db.getMetricBoundaries(cluster);
    const oldestBeforeBackfill = metricBoundariesBeforeBackfill.oldest;
    const backfillAlreadyComplete =
      indexerState?.backfillComplete === true &&
      indexerState.backfillDays >= backfillDays;
    const shouldBackfill =
      !backfillAlreadyComplete &&
      oldestBeforeBackfill !== null &&
      new Date(oldestBeforeBackfill.block_time).getTime() > backfillCutoffMs &&
      !isPastDeadline(deadlineMs);
    const backfill = await runBackfillPages({
      cluster,
      connection,
      programId,
      beforeSignature:
        indexerState?.backfillBeforeSignature ??
        oldestBeforeBackfill?.signature ??
        null,
      shouldBackfill,
      maxSignatures,
      maxBackfillPages,
      parseDelayMs,
      backfillCutoffMs,
      deadlineMs,
      db,
    });
    skippedTransactions += backfill.skippedTransactions;
    warnings.push(...backfill.warnings);
    if (backfill.deadlineReached) {
      warnings.push('Indexer runtime budget reached during backfill');
    }

    const newestSignature = newestSignatures[0];
    const lastSeenSignature =
      newestSignature?.signature ?? cursor?.last_seen_signature ?? null;
    const lastIndexedSlot = newestSignature?.slot ?? cursor?.last_indexed_slot ?? null;
    const lastIndexedAt = new Date().toISOString();
    const shouldRecordRun = Boolean(
      newestSignature || cursor || backfill.fetchedSignatures > 0,
    );
    if (shouldRecordRun) {
      await db.upsertCursor({
        cluster,
        last_seen_signature: lastSeenSignature,
        last_indexed_slot: lastIndexedSlot,
        last_indexed_at: lastIndexedAt,
      });
    }

    const metricBoundaries = await db.getMetricBoundaries(cluster);
    await refreshProtocolStatsSnapshot(cluster, db, warnings);

    const backfillComplete = backfill.complete || backfillAlreadyComplete;
    const runStatus: IndexerState['lastRunStatus'] =
      warnings.length > 0 || !backfillComplete ? 'partial' : 'success';
    const completedAt = new Date().toISOString();
    await db.upsertIndexerState(
      cluster,
      mergeIndexerState(indexerState, {
        lastRunStartedAt: runStartedIso,
        lastRunCompletedAt: completedAt,
        lastRunStatus: runStatus,
        lastRunError: null,
        lastRunWarningsCount: warnings.length,
        newestIndexedAt: metricBoundaries.newest?.block_time ?? null,
        oldestIndexedAt: metricBoundaries.oldest?.block_time ?? null,
        backfillStartedAt:
          indexerState?.backfillStartedAt ??
          (shouldBackfill || backfill.fetchedSignatures > 0 ? runStartedIso : null),
        backfillCompletedAt: backfillComplete
          ? completedAt
          : (indexerState?.backfillCompletedAt ?? null),
        backfillBeforeSignature: backfill.nextBeforeSignature,
        backfillComplete,
        backfillDays,
        backfillUpdatedAt: completedAt,
        lastSuccessfulRunAt: completedAt,
      }),
    );

    return buildRunResult({
      cluster,
      fetchedSignatures: newestSignatures.length + backfill.fetchedSignatures,
      backfillFetchedSignatures: backfill.fetchedSignatures,
      indexedTransactions: newestIndexedTransactions + backfill.indexedTransactions,
      skippedTransactions,
      warnings,
      lastSeenSignature,
      lastIndexedSlot,
      lastIndexedAt: shouldRecordRun ? lastIndexedAt : null,
      backfillComplete,
      oldestIndexed: metricBoundaries.oldest,
      newestIndexed: metricBoundaries.newest,
      runStatus,
      lastRunError: null,
    });
  } catch (error) {
    const message = formatIndexerError(error);
    warnings.push(message);
    const completedAt = new Date().toISOString();
    const metricBoundaries = await db.getMetricBoundaries(cluster).catch(() => ({
      oldest: null,
      newest: null,
    }));
    await db.upsertIndexerState(
      cluster,
      mergeIndexerState(indexerState, {
        lastRunStartedAt: runStartedIso,
        lastRunCompletedAt: completedAt,
        lastRunStatus: 'failed',
        lastRunError: message,
        lastRunWarningsCount: warnings.length,
        newestIndexedAt:
          metricBoundaries.newest?.block_time ?? indexerState?.newestIndexedAt ?? null,
        oldestIndexedAt:
          metricBoundaries.oldest?.block_time ?? indexerState?.oldestIndexedAt ?? null,
        backfillDays,
      }),
    );
    return buildRunResult({
      cluster,
      fetchedSignatures: 0,
      backfillFetchedSignatures: 0,
      indexedTransactions: 0,
      skippedTransactions: 0,
      warnings,
      lastSeenSignature: cursor?.last_seen_signature ?? null,
      lastIndexedSlot: cursor?.last_indexed_slot ?? null,
      lastIndexedAt: cursor?.last_indexed_at ?? null,
      backfillComplete: indexerState?.backfillComplete ?? false,
      oldestIndexed: metricBoundaries.oldest,
      newestIndexed: metricBoundaries.newest,
      runStatus: 'failed',
      lastRunError: message,
    });
  }
}

async function refreshProtocolStatsSnapshot(
  cluster: ClusterId,
  db: SupabaseRestClient,
  warnings: string[],
): Promise<void> {
  try {
    const protocolStats = await getCachedProtocolStats(cluster);
    await db.upsertProtocolStatsSnapshot(cluster, {
      ...protocolStats,
      cache: {
        hit: false,
        ttlSeconds: 30,
      },
    });
  } catch (error) {
    warnings.push(`Protocol snapshot refresh failed: ${formatFetchError(error)}`);
  }
}

async function writeParsedRows(
  cluster: ClusterId,
  db: SupabaseRestClient,
  rows: readonly ProtocolTransactionRow[],
): Promise<number> {
  const dedupedRows = dedupeProtocolTransactionRows(rows);
  if (dedupedRows.length === 0) return 0;

  await Promise.all([
    db.upsertMetricBuckets(buildMetricBuckets(dedupedRows)),
    db.upsertLatestProtocolTransactions(
      dedupedRows.map(toLatestProtocolTransactionRow),
    ),
  ]);
  await db.pruneLatestProtocolTransactions(cluster, 50);
  return dedupedRows.length;
}

export function buildMetricBuckets(
  rows: readonly ProtocolTransactionRow[],
) {
  const buckets = new Map<
    string,
    ReturnType<typeof emptyMetricBucket>
  >();

  for (const row of rows) {
    for (const granularity of ['hour', 'day'] as const) {
      const bucketStart = bucketStartIso(row.block_time, granularity);
      const key = `${row.cluster}:${granularity}:${bucketStart}`;
      const bucket =
        buckets.get(key) ?? emptyMetricBucket(row.cluster, granularity, bucketStart);
      bucket.tx_count += 1;
      if (row.status === 'success') {
        bucket.success_count += 1;
        bucket.fee_lamports = (
          BigInt(bucket.fee_lamports) + BigInt(row.protocol_fee_lamports)
        ).toString();
      } else {
        bucket.failed_count += 1;
      }
      if (row.status === 'success' && row.method === 'CreateWallet') {
        bucket.create_wallet_count += 1;
      }
      if (row.method === 'Execute') bucket.execute_count += 1;
      if (row.method === 'ExecuteDeferred') bucket.execute_deferred_count += 1;
      buckets.set(key, bucket);
    }
  }

  return [...buckets.values()];
}

function emptyMetricBucket(
  cluster: ClusterId,
  bucket_granularity: 'hour' | 'day',
  bucket_start: string,
) {
  return {
    cluster,
    bucket_start,
    bucket_granularity,
    tx_count: 0,
    success_count: 0,
    failed_count: 0,
    fee_lamports: '0',
    create_wallet_count: 0,
    execute_count: 0,
    execute_deferred_count: 0,
  };
}

function bucketStartIso(
  value: string,
  granularity: 'hour' | 'day',
): string {
  const date = new Date(value);
  if (granularity === 'hour') {
    date.setUTCMinutes(0, 0, 0);
  } else {
    date.setUTCHours(0, 0, 0, 0);
  }
  return date.toISOString();
}

function toLatestProtocolTransactionRow(row: ProtocolTransactionRow) {
  return {
    cluster: row.cluster,
    signature: row.signature,
    slot: row.slot,
    block_time: row.block_time,
    fee_payer: row.fee_payer,
    wallet_pda: row.wallet_pda,
    method: row.method,
    status: row.status,
    fee_lamports: row.protocol_fee_lamports,
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
  deadlineMs,
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
  deadlineMs: number;
  db: SupabaseRestClient;
}): Promise<{
  fetchedSignatures: number;
  indexedTransactions: number;
  skippedTransactions: number;
  warnings: string[];
  complete: boolean;
  nextBeforeSignature: string | null;
  deadlineReached: boolean;
}> {
  if (!shouldBackfill || !beforeSignature) {
    return {
      fetchedSignatures: 0,
      indexedTransactions: 0,
      skippedTransactions: 0,
      warnings: [],
      complete: true,
      nextBeforeSignature: beforeSignature,
      deadlineReached: false,
    };
  }

  let before = beforeSignature;
  let fetchedSignatures = 0;
  let indexedTransactions = 0;
  let skippedTransactions = 0;
  const warnings: string[] = [];
  let nextBeforeSignature: string | null = before;
  let deadlineReached = false;

  for (let page = 0; page < maxBackfillPages; page += 1) {
    if (isPastDeadline(deadlineMs)) {
      deadlineReached = true;
      break;
    }

    const signatures = await getSignaturesWithRetry(connection, programId, {
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
      deadlineMs,
    );
    indexedTransactions += await writeParsedRows(cluster, db, parsed.rows);
    skippedTransactions += parsed.skippedTransactions;
    warnings.push(...parsed.warnings);
    if (parsed.deadlineReached) {
      deadlineReached = true;
      break;
    }

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
        deadlineReached,
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
    deadlineReached,
  };
}

async function parseSignatureBatch(
  cluster: ClusterId,
  connection: Connection,
  signatures: Awaited<ReturnType<Connection['getSignaturesForAddress']>>,
  parseDelayMs = getIndexerParseDelayMs(),
  deadlineMs = Number.POSITIVE_INFINITY,
): Promise<{
  rows: ProtocolTransactionRow[];
  skippedTransactions: number;
  warnings: string[];
  deadlineReached: boolean;
}> {
  const rows: ProtocolTransactionRow[] = [];
  const warnings: string[] = [];
  let skippedTransactions = 0;
  let deadlineReached = false;

  for (const item of signatures) {
    if (isPastDeadline(deadlineMs)) {
      deadlineReached = true;
      break;
    }

    let tx = null;
    try {
      tx = await getParsedTransactionWithRetry(connection, item.signature);
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

  return { rows, skippedTransactions, warnings, deadlineReached };
}

function formatFetchError(error: unknown): string {
  if (!(error instanceof Error)) return 'Transaction fetch failed';
  const firstLine = error.message.split('\n')[0] ?? error.message;
  return `Transaction fetch failed: ${firstLine.slice(0, 180)}`;
}

async function getSignaturesWithRetry(
  connection: Connection,
  programId: ReturnType<typeof programIdForCluster>,
  options: SignaturesForAddressOptions,
) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await connection.getSignaturesForAddress(programId, options);
    } catch (error) {
      if (!isRateLimitError(error) || attempt === maxAttempts) throw error;
      await sleep(1_500 * attempt);
    }
  }
  return [];
}

async function getParsedTransactionWithRetry(
  connection: Connection,
  signature: string,
) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await connection.getParsedTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
    } catch (error) {
      if (!isRateLimitError(error) || attempt === maxAttempts) throw error;
      await sleep(1_500 * attempt);
    }
  }
  return null;
}

export function mergeIndexerState(
  previous: IndexerState | null,
  patch: Partial<IndexerState>,
): IndexerState {
  return {
    lastRunStartedAt: previous?.lastRunStartedAt ?? null,
    lastRunCompletedAt: previous?.lastRunCompletedAt ?? null,
    lastRunStatus: previous?.lastRunStatus ?? 'idle',
    lastRunError: previous?.lastRunError ?? null,
    lastRunWarningsCount: previous?.lastRunWarningsCount ?? 0,
    newestIndexedAt: previous?.newestIndexedAt ?? null,
    oldestIndexedAt: previous?.oldestIndexedAt ?? null,
    backfillStartedAt: previous?.backfillStartedAt ?? null,
    backfillCompletedAt: previous?.backfillCompletedAt ?? null,
    backfillBeforeSignature: previous?.backfillBeforeSignature ?? null,
    backfillComplete: previous?.backfillComplete ?? false,
    backfillDays: previous?.backfillDays ?? 0,
    backfillUpdatedAt: previous?.backfillUpdatedAt ?? null,
    lastSuccessfulRunAt: previous?.lastSuccessfulRunAt ?? null,
    ...patch,
  };
}

function buildRunResult(params: {
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
  oldestIndexed: IndexedTransactionBoundary | null;
  newestIndexed: IndexedTransactionBoundary | null;
  runStatus: IndexerState['lastRunStatus'];
  lastRunError: string | null;
}): IndexerRunResult {
  return {
    cluster: params.cluster,
    fetchedSignatures: params.fetchedSignatures,
    backfillFetchedSignatures: params.backfillFetchedSignatures,
    indexedTransactions: params.indexedTransactions,
    skippedTransactions: params.skippedTransactions,
    warnings: params.warnings,
    warningsCount: params.warnings.length,
    lastSeenSignature: params.lastSeenSignature,
    lastIndexedSlot: params.lastIndexedSlot,
    lastIndexedAt: params.lastIndexedAt,
    backfillComplete: params.backfillComplete,
    oldestIndexedAt: params.oldestIndexed?.block_time ?? null,
    newestIndexedAt: params.newestIndexed?.block_time ?? null,
    runStatus: params.runStatus,
    lastRunError: params.lastRunError,
  };
}

function isRateLimitError(error: unknown): boolean {
  return error instanceof Error && /\b429\b|too many requests/i.test(error.message);
}

function formatIndexerError(error: unknown): string {
  if (!(error instanceof Error)) return 'Indexer failed';
  return error.message.split('\n')[0]?.slice(0, 240) ?? 'Indexer failed';
}

function isPastDeadline(deadlineMs: number): boolean {
  return Date.now() >= deadlineMs;
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
