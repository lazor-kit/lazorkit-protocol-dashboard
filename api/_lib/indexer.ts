import { Connection } from '@solana/web3.js';
import { type ClusterId, programIdForCluster } from '../../src/solana/shared';
import {
  getBackfillDays,
  getIndexerMaxSignatures,
  rpcUrlForCluster,
} from './env';
import { SupabaseRestClient, type ProtocolTransactionRow } from './database';
import { parseLazorKitTransaction } from './transactionParser';

export interface IndexerRunResult {
  cluster: ClusterId;
  fetchedSignatures: number;
  indexedTransactions: number;
  skippedTransactions: number;
  warnings: string[];
  lastSeenSignature: string | null;
  lastIndexedSlot: number | null;
  lastIndexedAt: string | null;
}

export async function runIndexer(
  cluster: ClusterId,
  db = new SupabaseRestClient(),
): Promise<IndexerRunResult> {
  const connection = new Connection(rpcUrlForCluster(cluster), 'confirmed');
  const programId = programIdForCluster(cluster);
  const cursor = await db.getCursor(cluster);
  const maxSignatures = getIndexerMaxSignatures();
  const backfillCutoffMs = Date.now() - getBackfillDays() * 24 * 60 * 60 * 1000;

  const signatures = await connection.getSignaturesForAddress(programId, {
    limit: maxSignatures,
    until: cursor?.last_seen_signature ?? undefined,
  });

  const filteredSignatures = cursor
    ? signatures
    : signatures.filter(
        (item) =>
          typeof item.blockTime !== 'number' ||
          item.blockTime * 1000 >= backfillCutoffMs,
      );

  const rows: ProtocolTransactionRow[] = [];
  const warnings: string[] = [];
  let skippedTransactions = 0;

  for (const item of filteredSignatures) {
    const tx = await connection.getParsedTransaction(item.signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    const parsed = parseLazorKitTransaction(cluster, item.signature, tx);
    warnings.push(
      ...parsed.warnings.map((warning) => `${item.signature}: ${warning}`),
    );
    if (parsed.row) {
      rows.push(parsed.row);
    } else {
      skippedTransactions += 1;
    }
  }

  await db.upsertProtocolTransactions(dedupeProtocolTransactionRows(rows));

  const newest = signatures[0];
  const lastIndexedAt = new Date().toISOString();
  if (newest) {
    await db.upsertCursor({
      cluster,
      last_seen_signature: newest.signature,
      last_indexed_slot: newest.slot,
      last_indexed_at: lastIndexedAt,
    });
  }

  return {
    cluster,
    fetchedSignatures: signatures.length,
    indexedTransactions: rows.length,
    skippedTransactions,
    warnings,
    lastSeenSignature: newest?.signature ?? cursor?.last_seen_signature ?? null,
    lastIndexedSlot: newest?.slot ?? cursor?.last_indexed_slot ?? null,
    lastIndexedAt: newest ? lastIndexedAt : cursor?.last_indexed_at ?? null,
  };
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
