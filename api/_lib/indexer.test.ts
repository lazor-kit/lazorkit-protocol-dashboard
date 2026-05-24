import {
  buildMetricBuckets,
  dedupeProtocolTransactionRows,
  mergeIndexerState,
} from './indexer.js';
import type { ProtocolTransactionRow } from './database.js';

function row(signature: string, slot: number): ProtocolTransactionRow {
  return {
    cluster: 'mainnet',
    signature,
    slot,
    block_time: '2026-05-24T00:00:00.000Z',
    fee_payer: 'payer',
    wallet_pda: 'wallet',
    method: 'Execute',
    status: 'success',
    protocol_fee_lamports: '1',
    treasury_shard: null,
    fee_record: null,
    instruction_index: 0,
    parse_warnings: [],
  };
}

describe('indexer helpers', () => {
  it('deduplicates rows by cluster and signature before upsert', () => {
    expect(
      dedupeProtocolTransactionRows([
        row('same', 1),
        row('same', 2),
        { ...row('same', 3), cluster: 'devnet' },
      ]),
    ).toEqual([row('same', 2), { ...row('same', 3), cluster: 'devnet' }]);
  });

  it('aggregates parsed rows into hourly and daily metric buckets', () => {
    const buckets = buildMetricBuckets([
      row('create', 1),
      { ...row('failed', 2), status: 'failed', protocol_fee_lamports: '99' },
      {
        ...row('deferred', 3),
        method: 'ExecuteDeferred',
        protocol_fee_lamports: '2',
        block_time: '2026-05-24T00:30:00.000Z',
      },
    ]);

    const hourly = buckets.find(
      (bucket) =>
        bucket.bucket_granularity === 'hour' &&
        bucket.bucket_start === '2026-05-24T00:00:00.000Z',
    );
    const daily = buckets.find(
      (bucket) =>
        bucket.bucket_granularity === 'day' &&
        bucket.bucket_start === '2026-05-24T00:00:00.000Z',
    );

    expect(hourly).toMatchObject({
      tx_count: 3,
      success_count: 2,
      failed_count: 1,
      fee_lamports: '3',
      execute_count: 2,
      execute_deferred_count: 1,
    });
    expect(daily).toMatchObject({
      tx_count: 3,
      success_count: 2,
      failed_count: 1,
      fee_lamports: '3',
    });
  });

  it('merges indexer state without dropping coverage fields', () => {
    const merged = mergeIndexerState(
      {
        lastRunStartedAt: '2026-05-24T00:00:00.000Z',
        lastRunCompletedAt: null,
        lastRunStatus: 'running',
        lastRunError: null,
        lastRunWarningsCount: 0,
        newestIndexedAt: '2026-05-24T00:00:00.000Z',
        oldestIndexedAt: '2026-05-01T00:00:00.000Z',
        backfillStartedAt: '2026-05-24T00:00:00.000Z',
        backfillCompletedAt: null,
        backfillBeforeSignature: 'before',
        backfillComplete: false,
        backfillDays: 60,
        backfillUpdatedAt: null,
        lastSuccessfulRunAt: null,
      },
      {
        lastRunStatus: 'partial',
        lastRunWarningsCount: 2,
      },
    );

    expect(merged.lastRunStatus).toBe('partial');
    expect(merged.lastRunWarningsCount).toBe(2);
    expect(merged.oldestIndexedAt).toBe('2026-05-01T00:00:00.000Z');
    expect(merged.backfillBeforeSignature).toBe('before');
  });
});
