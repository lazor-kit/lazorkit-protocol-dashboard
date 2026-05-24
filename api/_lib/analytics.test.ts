import {
  buildKpis,
  buildNetworkComparison,
  buildSeries,
} from './analytics';
import type { ProtocolTransactionRow } from './database';

function row(partial: Partial<ProtocolTransactionRow>): ProtocolTransactionRow {
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
    treasury_shard: null,
    fee_record: null,
    instruction_index: 0,
    parse_warnings: [],
    ...partial,
  };
}

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

  it('buckets chart series for supported windows', () => {
    const now = new Date('2026-05-24T00:00:00.000Z').getTime();
    const series = buildSeries(
      [
        row({
          block_time: '2026-05-23T23:00:00.000Z',
          wallet_pda: 'wallet-a',
          protocol_fee_lamports: '10',
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
    expect(series.at(-1)?.feesLamports).toBe('25');
    expect(buildSeries([], '7d', now)).toHaveLength(7);
    expect(buildSeries([], '30d', now)).toHaveLength(30);
  });

  it('compares mainnet and devnet activity', () => {
    const comparison = buildNetworkComparison([
      row({ cluster: 'mainnet' }),
      row({ cluster: 'mainnet' }),
      row({ cluster: 'devnet' }),
    ]);
    expect(comparison).toEqual({ mainnetTxCount: 2, devnetTxCount: 1 });
  });
});
