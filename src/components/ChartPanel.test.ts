import { axisDecimals, axisTicks, formatBucket, niceStep, xTicks } from './ChartPanel';

describe('chart axes', () => {
  it('picks tight nice ticks', () => {
    expect(axisTicks(101, 'count')).toEqual([0, 30, 60, 90, 120]);
    expect(axisTicks(12, 'count')).toEqual([0, 3, 6, 9, 12]);
    expect(axisTicks(0, 'count')).toEqual([0, 1, 2, 3, 4]);
    expect(axisTicks(6, 'count')).toEqual([0, 2, 4, 6]);
    expect(axisTicks(0.0003, 'lamports')).toEqual([0, 0.0001, 0.0002, 0.0003]);
    expect(niceStep(7, 4, true)).toBe(2);
  });

  it('gives SOL ticks enough decimals to stay distinct', () => {
    expect(axisDecimals([0, 0.0001, 0.0002])).toBe(4);
    expect(axisDecimals([0, 0.000025, 0.00005])).toBe(6);
    expect(axisDecimals([0, 1, 2])).toBe(0);
  });

  it('formats buckets per size', () => {
    expect(formatBucket('2026-09-28', 'week')).toBe('Sep 28');
    expect(formatBucket('2026-09-28', 'week', true)).toBe('Week of Sep 28, 2026');
    expect(formatBucket('2026-09-01', 'month', true)).toBe('Sep 2026');
    expect(formatBucket('2026-10-01T05:00:00Z', 'hour')).toBe('05:00');
    expect(formatBucket('2026-10-01T05:00:00Z', 'hour', true)).toBe('Oct 1, 05:00 UTC');
  });

  it('spreads at most six x ticks across the range', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ bucket: `b${i}`, v1: 0, v2: 0, total: 0, failed: 0 }));
    expect(xTicks(rows)).toEqual(['b0', 'b6', 'b12', 'b17', 'b23', 'b29']);
  });
});
