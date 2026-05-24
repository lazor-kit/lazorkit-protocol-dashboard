import { loadApiEnv } from './loadApiEnv.js';
import { buildMetricBuckets, dedupeProtocolTransactionRows } from '../api/_lib/indexer.js';
import { SupabaseRestClient } from '../api/_lib/database.js';
import { getCachedProtocolStats } from '../api/_lib/protocolStats.js';
import type { ClusterId } from '../src/solana/shared.js';

loadApiEnv();

const clusters: ClusterId[] = ['mainnet', 'devnet'];
const pageSize = 1000;

void main();

async function main() {
  const db = new SupabaseRestClient();
  await db.clearAggregateAnalytics();

  for (const cluster of clusters) {
    const rows = [];
    for (let offset = 0; ; offset += pageSize) {
      const page = await db.selectProtocolTransactions({
        cluster,
        sinceIso: '1970-01-01T00:00:00.000Z',
        order: 'asc',
        limit: pageSize,
        offset,
      });
      rows.push(...page);
      if (page.length < pageSize) break;
    }

    const dedupedRows = dedupeProtocolTransactionRows(rows);
    await db.upsertMetricBuckets(buildMetricBuckets(dedupedRows));
    await db.upsertLatestProtocolTransactions(
      dedupedRows.map((row) => ({
        cluster: row.cluster,
        signature: row.signature,
        slot: row.slot,
        block_time: row.block_time,
        fee_payer: row.fee_payer,
        wallet_pda: row.wallet_pda,
        method: row.method,
        status: row.status,
        fee_lamports: row.protocol_fee_lamports,
      })),
    );
    await db.pruneLatestProtocolTransactions(cluster, 50);

    const protocolStats = await getCachedProtocolStats(cluster);
    await db.upsertProtocolStatsSnapshot(cluster, protocolStats);

    console.log(
      JSON.stringify(
        {
          cluster,
          sourceTransactions: rows.length,
          dedupedTransactions: dedupedRows.length,
          buckets: buildMetricBuckets(dedupedRows).length,
          latestRetained: 50,
          protocolInitialized: protocolStats.initialized,
        },
        null,
        2,
      ),
    );
  }
}
