import { loadApiEnv } from './loadApiEnv.js';
import { runIndexer } from '../api/_lib/indexer.js';
import type { ClusterId } from '../src/solana/shared.js';
import { appendFile } from 'node:fs/promises';

loadApiEnv();

const clusterArg = process.argv[2] ?? 'all';
const clusters = resolveClusters(clusterArg);

void main();

async function main() {
  const summaries: Array<Record<string, string | number | boolean | null>> = [];
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
    summaries.push(summary);
    console.log(JSON.stringify(summary, null, 2));
  }
  await writeGithubSummary(summaries);
}

function resolveClusters(value: string): ClusterId[] {
  if (value === 'all') return ['mainnet', 'devnet'];
  if (value === 'mainnet' || value === 'devnet') return [value];
  throw new Error('Usage: npm run indexer:mainnet | indexer:devnet | indexer:all');
}

async function writeGithubSummary(
  summaries: Array<Record<string, string | number | boolean | null>>,
) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath || summaries.length === 0) return;

  const rows = summaries
    .map((summary) =>
      [
        summary.cluster,
        summary.runStatus,
        summary.fetchedSignatures,
        summary.indexedTransactions,
        summary.skippedTransactions,
        summary.warningsCount,
        summary.backfillComplete,
        summary.newestIndexedAt ?? '-',
        summary.lastRunError ?? '-',
      ].join(' | '),
    )
    .join('\n');

  await appendFile(
    summaryPath,
    [
      '## LazorKit Dashboard Indexer',
      '',
      'cluster | status | fetched | indexed | skipped | warnings | backfill complete | newest indexed | error',
      '--- | --- | ---: | ---: | ---: | ---: | --- | --- | ---',
      rows,
      '',
    ].join('\n'),
  );
}
