// The temporary adapter keeps the current UI working on the v2 payload until the new UI replaces it.
import mainnetAll from '../types/__fixtures__/dashboard-mainnet-all.json';
import setupRequired from '../types/__fixtures__/setup-required.json';
import type { DashboardPayload } from '../types/dashboard';
import { adaptPayload } from './fetchDashboardStats';

describe('temporary v2 payload adapter', () => {
  it('maps the real mainnet payload onto the old shape', () => {
    const payload = mainnetAll as unknown as DashboardPayload;
    const stats = adaptPayload(payload, 50);
    expect(stats.kpis.totalTransactions.value).toBe(payload.kpis.cluster?.current.txs);
    expect(stats.kpis.totalFeesLamports.value).toBe(payload.kpis.cluster?.current.feeLamports);
    expect(stats.protocolStats?.programId).toBe('LazorjRFNavitUaBu5m3WaNPjU1maipvSW2rZfAFAKi');
    expect(stats.protocolStats?.shards).toHaveLength(16);
    expect(stats.latestTransactions.length).toBe(payload.latest.length);
    expect(stats.series.length).toBe(payload.series.filter((point) => point.scope === 'cluster').length);
    expect(stats.setupRequired).toBe(false);
  });

  it('maps setup_required onto the old not_configured state', () => {
    const stats = adaptPayload(setupRequired as unknown as DashboardPayload);
    expect(stats.setupRequired).toBe(true);
    expect(stats.health.analyticsStatus).toBe('not_configured');
    expect(stats.protocolStats).toBeNull();
  });
});
