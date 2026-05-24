import {
  buildChartSummaryValue,
  buildXAxisTicks,
  buildYAxisDomain,
  buildYAxisTicks,
  formatTooltipLabel,
  formatXAxisTick,
  formatYAxisTick,
  toChartData,
} from './ChartPanel';
import type { SeriesPoint } from '../solana/dashboardTypes';

function point(partial: Partial<SeriesPoint>): SeriesPoint {
  return {
    bucket: '2026-05-24T00:00:00.000Z',
    txCount: 0,
    uniqueWallets: 0,
    createWalletCount: 0,
    feesLamports: '0',
    feeEventCount: 0,
    ...partial,
  };
}

describe('chart panel helpers', () => {
  it('normalizes chart data for Recharts', () => {
    expect(
      toChartData([
        point({ txCount: 3, uniqueWallets: 2, feesLamports: '5000000' }),
      ]),
    ).toEqual([
      {
        bucket: '2026-05-24T00:00:00.000Z',
        txCount: 3,
        uniqueWallets: 2,
        createWalletCount: 0,
        feesLamports: 5_000_000,
        feeEventCount: 0,
      },
    ]);
  });

  it('builds stable y domains for empty and populated charts', () => {
    expect(buildYAxisDomain([], 'txCount')).toEqual([0, 4]);
    expect(buildYAxisDomain([toChartData([point({ txCount: 7 })])[0]], 'txCount')).toEqual([0, 8]);
    expect(buildYAxisDomain([], 'feesLamports')).toEqual([0, 1]);
    expect(
      buildYAxisDomain([toChartData([point({ feesLamports: '5000' })])[0]], 'feesLamports'),
    ).toEqual([0, 5000]);
  });

  it('builds explicit y ticks so integer labels do not duplicate', () => {
    expect(buildYAxisTicks([0, 4])).toEqual([0, 1, 2, 3, 4]);
    expect(buildYAxisTicks([0, 20])).toEqual([0, 5, 10, 15, 20]);
  });

  it('limits x-axis ticks to readable positions', () => {
    const data = toChartData(
      Array.from({ length: 24 }, (_, index) =>
        point({ bucket: new Date(2026, 4, 24, index).toISOString() }),
      ),
    );
    expect(buildXAxisTicks(data)).toHaveLength(5);
    expect(buildXAxisTicks(data)[0]).toBe(data[0].bucket);
    expect(buildXAxisTicks(data).at(-1)).toBe(data.at(-1)?.bucket);
  });

  it('formats axis and tooltip labels compactly', () => {
    expect(formatYAxisTick(5000, 'feesLamports')).toBe('0.000005');
    expect(formatYAxisTick(4_000_000, 'feesLamports')).toBe('0.004');
    expect(formatYAxisTick(4, 'txCount')).toBe('4');
    expect(formatXAxisTick('2026-05-24T13:00:00.000Z', '24h')).toContain('PM');
    expect(formatXAxisTick('2026-05-24T13:00:00.000Z', 'all')).toBe('May 24');
    expect(formatTooltipLabel('2026-05-24T13:00:00.000Z', '30d')).toContain('2026');
  });

  it('summarizes wallet account charts by current count instead of summing buckets', () => {
    const data = toChartData([
      point({ uniqueWallets: 37 }),
      point({ uniqueWallets: 37 }),
      point({ uniqueWallets: 37 }),
    ]);

    expect(buildChartSummaryValue(data, 'uniqueWallets')).toBe(37);
    expect(buildChartSummaryValue(data, 'txCount')).toBe(0);
  });

  it('summarizes wallets-created charts as period activity', () => {
    const data = toChartData([
      point({ createWalletCount: 2 }),
      point({ createWalletCount: 3 }),
      point({ createWalletCount: 4 }),
    ]);

    expect(buildChartSummaryValue(data, 'createWalletCount')).toBe(9);
  });
});
