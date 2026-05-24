import {
  buildChartModel,
  buildXAxisTicks,
  buildYAxisTicks,
  getChartValue,
  getNearestSeriesIndex,
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
  it('extracts metric values and keeps empty charts scaled', () => {
    expect(getChartValue(point({ txCount: 3 }), 'txCount')).toBe(3);
    expect(getChartValue(point({ uniqueWallets: 2 }), 'uniqueWallets')).toBe(2);
    expect(getChartValue(point({ feesLamports: '50' }), 'feesLamports')).toBe(50);

    const model = buildChartModel([point({}), point({})], 'txCount');
    expect(model.points).toHaveLength(2);
    expect(model.yTicks).toHaveLength(5);
    expect(model.linePoints).not.toBe('');
  });

  it('builds y and x ticks for supported windows', () => {
    const yTicks = buildYAxisTicks(100);
    expect(yTicks.map((tick) => tick.value)).toEqual([100, 75, 50, 25, 0]);

    expect(buildXAxisTicks(24)).toHaveLength(5);
    expect(buildXAxisTicks(7)).toHaveLength(5);
    expect(buildXAxisTicks(30)).toHaveLength(5);
  });

  it('finds nearest point from pointer x position', () => {
    const rect = { left: 100, width: 200 };
    expect(getNearestSeriesIndex(100, rect, 5)).toBe(0);
    expect(getNearestSeriesIndex(200, rect, 5)).toBe(2);
    expect(getNearestSeriesIndex(300, rect, 5)).toBe(4);
    expect(getNearestSeriesIndex(90, rect, 5)).toBe(0);
    expect(getNearestSeriesIndex(320, rect, 5)).toBe(4);
    expect(getNearestSeriesIndex(200, rect, 0)).toBeNull();
  });

  it('keeps tooltip payload source values in the chart model', () => {
    const series = [
      point({ txCount: 1, uniqueWallets: 1, feesLamports: '10' }),
      point({ txCount: 2, uniqueWallets: 2, feesLamports: '20' }),
    ];
    const model = buildChartModel(series, 'feesLamports');

    expect(model.total).toBe(30);
    expect(model.areaPoints).toContain(',');
    expect(series[1]).toMatchObject({
      txCount: 2,
      uniqueWallets: 2,
      feesLamports: '20',
    });
  });
});
