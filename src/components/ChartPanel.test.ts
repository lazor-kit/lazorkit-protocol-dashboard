import {
  buildXAxisTicks,
  buildYAxisDomain,
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
    feesLamports: '0',
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
        feesLamports: 5_000_000,
      },
    ]);
  });

  it('builds stable y domains for empty and populated charts', () => {
    expect(buildYAxisDomain([], 'txCount')).toEqual([0, 4]);
    expect(buildYAxisDomain([toChartData([point({ txCount: 7 })])[0]], 'txCount')).toEqual([
      0,
      10,
    ]);
    expect(buildYAxisDomain([], 'feesLamports')).toEqual([0, 4_000_000]);
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
    expect(formatYAxisTick(4_000_000, 'feesLamports')).toBe('0.004');
    expect(formatYAxisTick(4, 'txCount')).toBe('4');
    expect(formatXAxisTick('2026-05-24T13:00:00.000Z', '24h')).toContain('PM');
    expect(formatTooltipLabel('2026-05-24T13:00:00.000Z', '30d')).toContain('2026');
  });
});
