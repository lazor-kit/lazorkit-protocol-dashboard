import {
  buildKpis,
  buildKpisFromBuckets,
  buildNetworkComparison,
  buildNetworkComparisonFromBuckets,
  buildPagination,
  buildSeries,
  buildSeriesFromBuckets,
  buildCoverageLabel,
  classifyAnalyticsStatus,
  parseDashboardWindow,
  parseDashboardPagination,
} from './analytics.js';
import type { DashboardTransactionRow, ProtocolMetricBucketRow } from './database.js';
import type { ProtocolStats } from '../../src/solana/protocolStatsTypes.js';

function row(partial: Partial<DashboardTransactionRow>): DashboardTransactionRow {
  return {
    cluster: 'mainnet',
    signature: crypto.randomUUID(),
    slot: 1,
    block_time: '2026-05-24T00:00:00.000Z',
    fee_payer: 'payer',
    wallet_pda: 'wallet',
    method: 'Execute',
    status: 'success',
    protocol_fee_lamports: '0',
    ...partial,
  };
}

function bucket(
  partial: Partial<ProtocolMetricBucketRow>,
): ProtocolMetricBucketRow {
  return {
    cluster: 'mainnet',
    bucket_start: '2026-05-24T00:00:00.000Z',
    bucket_granularity: 'day',
    tx_count: 0,
    success_count: 0,
    failed_count: 0,
    fee_lamports: '0',
    create_wallet_count: 0,
    execute_count: 0,
    execute_deferred_count: 0,
    ...partial,
  };
}

const protocolStats = {
  walletAccountCount: 37,
} as ProtocolStats;

describe('analytics aggregation', () => {
  it('aggregates KPI windows and deltas', () => {
    const kpis = buildKpis(
      [
        row({ wallet_pda: 'wallet-a', protocol_fee_lamports: '10' }),
        row({ wallet_pda: 'wallet-b', protocol_fee_lamports: '20' }),
        row({ wallet_pda: 'wallet-b', status: 'failed', protocol_fee_lamports: '99' }),
      ],
      [row({ wallet_pda: 'wallet-a', protocol_fee_lamports: '5' })],
    );

    expect(kpis.totalTransactions.value).toBe(3);
    expect(kpis.uniqueWallets.value).toBe(2);
    expect(kpis.totalFeesLamports.value).toBe('30');
    expect(kpis.successRate.value).toBeCloseTo(2 / 3);
    expect(kpis.totalTransactions.percentChange).toBe(200);
  });

  it('aggregates KPIs from metric buckets and protocol wallet accounts', () => {
    const kpis = buildKpisFromBuckets(
      [
        bucket({ tx_count: 3, success_count: 2, failed_count: 1, fee_lamports: '10' }),
        bucket({ tx_count: 2, success_count: 2, fee_lamports: '15' }),
      ],
      [bucket({ tx_count: 1, success_count: 1, fee_lamports: '5' })],
      protocolStats,
    );

    expect(kpis.totalTransactions.value).toBe(5);
    expect(kpis.uniqueWallets.value).toBe(37);
    expect(kpis.totalFeesLamports.value).toBe('25');
    expect(kpis.successRate.value).toBe(0.8);
    expect(kpis.totalTransactions.percentChange).toBe(400);
  });

  it('buckets chart series for supported windows', () => {
    const now = new Date('2026-05-24T00:00:00.000Z').getTime();
    const series = buildSeries(
      [
        row({
          block_time: '2026-05-23T23:00:00.000Z',
          wallet_pda: 'wallet-a',
          protocol_fee_lamports: '10',
          method: 'CreateWallet',
        }),
        row({
          block_time: '2026-05-23T23:10:00.000Z',
          wallet_pda: 'wallet-a',
          protocol_fee_lamports: '15',
        }),
      ],
      '24h',
      now,
    );

    expect(series).toHaveLength(24);
    expect(series.at(-1)?.txCount).toBe(2);
    expect(series.at(-1)?.uniqueWallets).toBe(1);
    expect(series.at(-1)?.createWalletCount).toBe(1);
    expect(series.at(-1)?.feesLamports).toBe('25');
    expect(series.at(-1)?.feeEventCount).toBe(2);
    expect(buildSeries([], 'all', now)).toHaveLength(30);
    expect(buildSeries([], '7d', now)).toHaveLength(7);
    expect(buildSeries([], '30d', now)).toHaveLength(30);
  });

  it('builds chart series from metric buckets', () => {
    const now = new Date('2026-05-24T00:00:00.000Z').getTime();
    const series = buildSeriesFromBuckets(
      [
        bucket({
          bucket_start: '2026-05-23T23:00:00.000Z',
          bucket_granularity: 'hour',
          tx_count: 2,
          success_count: 2,
          fee_lamports: '25',
          create_wallet_count: 1,
        }),
      ],
      '24h',
      now,
      37,
    );

    expect(series).toHaveLength(24);
    expect(series.at(-1)?.txCount).toBe(2);
    expect(series.at(-1)?.uniqueWallets).toBe(37);
    expect(series.at(-1)?.createWalletCount).toBe(1);
    expect(series.at(-1)?.feesLamports).toBe('25');
    expect(series.at(-1)?.feeEventCount).toBe(2);
  });

  it('buckets all-time chart series across indexed activity', () => {
    const now = new Date('2026-05-24T00:00:00.000Z').getTime();
    const series = buildSeries(
      [
        row({
          block_time: '2026-03-24T00:00:00.000Z',
          wallet_pda: 'wallet-a',
          protocol_fee_lamports: '10',
        }),
        row({
          block_time: '2026-05-24T00:00:00.000Z',
          wallet_pda: 'wallet-b',
          protocol_fee_lamports: '15',
        }),
      ],
      'all',
      now,
    );

    expect(series).toHaveLength(30);
    expect(series.reduce((sum, point) => sum + point.txCount, 0)).toBe(2);
    expect(
      series.reduce((sum, point) => sum + BigInt(point.feesLamports), 0n),
    ).toBe(25n);
    expect(series.reduce((sum, point) => sum + point.feeEventCount, 0)).toBe(2);
  });

  it('compares mainnet and devnet activity', () => {
    const comparison = buildNetworkComparison([
      row({ cluster: 'mainnet' }),
      row({ cluster: 'mainnet' }),
      row({ cluster: 'devnet' }),
    ]);
    expect(comparison).toEqual({ mainnetTxCount: 2, devnetTxCount: 1 });
    expect(
      buildNetworkComparisonFromBuckets([
        bucket({ cluster: 'mainnet', tx_count: 5 }),
        bucket({ cluster: 'devnet', tx_count: 3 }),
      ]),
    ).toEqual({ mainnetTxCount: 5, devnetTxCount: 3 });
  });

  it('parses and builds latest transaction pagination', () => {
    expect(parseDashboardPagination({})).toEqual({ txPage: 1, txLimit: 10 });
    expect(parseDashboardPagination({ txPage: '2', txLimit: '15' })).toEqual({
      txPage: 2,
      txLimit: 15,
    });
    expect(parseDashboardPagination({ txPage: '0', txLimit: '10' })).toBeNull();
    expect(parseDashboardPagination({ txPage: '1', txLimit: '20' })).toBeNull();

    expect(buildPagination(2, 10, 35)).toEqual({
      page: 2,
      limit: 10,
      total: 35,
      totalPages: 4,
      hasPreviousPage: true,
      hasNextPage: true,
    });
    expect(buildPagination(1, 10, 0)).toEqual({
      page: 1,
      limit: 10,
      total: 0,
      totalPages: 1,
      hasPreviousPage: false,
      hasNextPage: false,
    });
    expect(parseDashboardWindow(undefined)).toBe('all');
    expect(parseDashboardWindow('all')).toBe('all');
  });

  it('classifies analytics coverage truthfully', () => {
    const now = new Date('2026-05-24T00:00:00.000Z').getTime();
    expect(
      classifyAnalyticsStatus({
        setupRequired: true,
        hasIndexedRows: false,
        indexerState: null,
        now,
      }),
    ).toBe('not_configured');
    expect(
      classifyAnalyticsStatus({
        setupRequired: false,
        hasIndexedRows: false,
        indexerState: null,
        now,
      }),
    ).toBe('empty');
    expect(
      classifyAnalyticsStatus({
        setupRequired: false,
        hasIndexedRows: true,
        indexerState: {
          lastRunStartedAt: null,
          lastRunCompletedAt: null,
          lastRunStatus: 'success',
          lastRunError: null,
          lastRunWarningsCount: 0,
          newestIndexedAt: null,
          oldestIndexedAt: null,
          backfillStartedAt: null,
          backfillCompletedAt: null,
          backfillBeforeSignature: null,
          backfillComplete: false,
          backfillDays: 60,
          backfillUpdatedAt: null,
          lastSuccessfulRunAt: new Date(now).toISOString(),
        },
        now,
      }),
    ).toBe('partial');
  });

  it('builds coverage labels from indexed boundaries', () => {
    expect(
      buildCoverageLabel({
        oldestIndexedAt: null,
        newestIndexedAt: null,
        analyticsStatus: 'empty',
      }),
    ).toBe('No indexed data yet');
    expect(
      buildCoverageLabel({
        oldestIndexedAt: '2026-05-01T00:00:00.000Z',
        newestIndexedAt: '2026-05-24T00:00:00.000Z',
        analyticsStatus: 'partial',
      }),
    ).toContain('Backfilling');
  });
});
