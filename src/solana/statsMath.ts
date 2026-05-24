export interface FeeRecordAmountRow {
  totalFeesPaidLamports: string | bigint;
  txCount: number;
  walletCount: number;
}

export interface AggregatedFeeRecordAmounts {
  recordCount: number;
  lifetimeFeesLamports: string;
  txCount: number;
  walletCount: number;
  feePayingEvents: number;
}

export function aggregateFeeRecords(
  feeRecords: ReadonlyArray<FeeRecordAmountRow>,
): AggregatedFeeRecordAmounts {
  const totals = feeRecords.reduce(
    (acc, row) => ({
      recordCount: acc.recordCount + 1,
      lifetimeFeesLamports:
        acc.lifetimeFeesLamports + BigInt(row.totalFeesPaidLamports),
      txCount: acc.txCount + row.txCount,
      walletCount: acc.walletCount + row.walletCount,
      feePayingEvents: acc.feePayingEvents + row.txCount + row.walletCount,
    }),
    {
      recordCount: 0,
      lifetimeFeesLamports: 0n,
      txCount: 0,
      walletCount: 0,
      feePayingEvents: 0,
    },
  );

  return {
    ...totals,
    lifetimeFeesLamports: totals.lifetimeFeesLamports.toString(),
  };
}

export function computeCollectibleLamports(
  balanceLamports: bigint,
  rentMinimumLamports: bigint,
): bigint {
  return balanceLamports > rentMinimumLamports
    ? balanceLamports - rentMinimumLamports
    : 0n;
}
