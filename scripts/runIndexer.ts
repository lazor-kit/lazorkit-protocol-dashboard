import { loadApiEnv } from './loadApiEnv.js';
import { runIndexer } from '../api/_lib/indexer.js';
import type { ClusterId } from '../src/solana/shared.js';

loadApiEnv();

const clusterArg = process.argv[2] ?? 'all';
const clusters = resolveClusters(clusterArg);

void main();

async function main() {
  for (const cluster of clusters) {
    const result = await runIndexer(cluster);
    const summary = {
      cluster: result.cluster,
      runStatus: result.runStatus,
      fetchedSignatures: result.fetchedSignatures,
      indexedTransactions: result.indexedTransactions,
      skippedTransactions: result.skippedTransactions,
      warningsCount: result.warningsCount,
      backfillComplete: result.backfillComplete,
      oldestIndexedAt: result.oldestIndexedAt,
      newestIndexedAt: result.newestIndexedAt,
      lastRunError: result.lastRunError,
    };
    console.log(JSON.stringify(summary, null, 2));
  }
}

function resolveClusters(value: string): ClusterId[] {
  if (value === 'all') return ['mainnet', 'devnet'];
  if (value === 'mainnet' || value === 'devnet') return [value];
  throw new Error('Usage: npm run indexer:mainnet | indexer:devnet | indexer:all');
}
