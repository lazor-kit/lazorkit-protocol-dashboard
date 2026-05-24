import { PublicKey } from '@solana/web3.js';
import {
  aggregateFeeRecords,
  computeCollectibleLamports,
  type FeeRecordRow,
} from './fetchProtocolStats';

function row(partial: Partial<FeeRecordRow>): FeeRecordRow {
  return {
    address: PublicKey.unique().toBase58(),
    discriminator: 6,
    bump: 1,
    version: 1,
    totalFeesPaid: 0n,
    txCount: 0,
    walletCount: 0,
    registeredAt: 0n,
    ...partial,
  };
}

describe('protocol stats aggregation', () => {
  it('aggregates empty fee records', () => {
    expect(aggregateFeeRecords([])).toEqual({
      recordCount: 0,
      lifetimeFeesLamports: 0n,
      txCount: 0,
      walletCount: 0,
      feePayingEvents: 0,
    });
  });

  it('aggregates fee records', () => {
    const totals = aggregateFeeRecords([
      row({ totalFeesPaid: 10n, txCount: 2, walletCount: 1 }),
      row({ totalFeesPaid: 25n, txCount: 5, walletCount: 3 }),
    ]);

    expect(totals.recordCount).toBe(2);
    expect(totals.lifetimeFeesLamports).toBe(35n);
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

