import {
  aggregateFeeRecords,
  computeCollectibleLamports,
  type FeeRecordAmountRow,
} from './statsMath';

function row(partial: Partial<FeeRecordAmountRow>): FeeRecordAmountRow {
  return {
    totalFeesPaidLamports: 0n,
    txCount: 0,
    walletCount: 0,
    ...partial,
  };
}

describe('protocol stats aggregation', () => {
  it('aggregates empty fee records', () => {
    expect(aggregateFeeRecords([])).toEqual({
      recordCount: 0,
      lifetimeFeesLamports: '0',
      txCount: 0,
      walletCount: 0,
      feePayingEvents: 0,
    });
  });

  it('aggregates fee records', () => {
    const totals = aggregateFeeRecords([
      row({ totalFeesPaidLamports: 10n, txCount: 2, walletCount: 1 }),
      row({ totalFeesPaidLamports: '25', txCount: 5, walletCount: 3 }),
    ]);

    expect(totals.recordCount).toBe(2);
    expect(totals.lifetimeFeesLamports).toBe('35');
    expect(totals.txCount).toBe(7);
    expect(totals.walletCount).toBe(4);
    expect(totals.feePayingEvents).toBe(11);
  });

  it('subtracts rent reserve from collectible shard balance', () => {
    expect(computeCollectibleLamports(15n, 10n)).toBe(5n);
    expect(computeCollectibleLamports(10n, 10n)).toBe(0n);
    expect(computeCollectibleLamports(5n, 10n)).toBe(0n);
  });
});
