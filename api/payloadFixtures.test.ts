// The payload fixtures were captured from the local API on a local Supabase filled by a full backfill from public
// RPC (see README "Development"). They are the UI's development data; this keeps them in step with the contract.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDashboardPayload } from '../src/types/validate.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'types', '__fixtures__');
const read = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>;

describe('payload fixtures', () => {
  const names = readdirSync(dir).filter((name) => name.startsWith('dashboard-'));

  it('cover both clusters and every window', () => {
    expect(names.sort()).toEqual(
      ['mainnet', 'devnet'].flatMap((c) => ['24h', '7d', '30d', 'all'].map((w) => `dashboard-${c}-${w}.json`)).sort(),
    );
  });

  for (const name of names) {
    it(`${name} matches the contract`, () => {
      expect(validateDashboardPayload(read(name))).toEqual([]);
    });
  }

  it('integrators are the 10 biggest by created + ops, in that order (not the first 10 by name)', () => {
    for (const name of names) {
      const payload = read(name) as { breakdowns: Record<string, { byApp: Array<{ app: string; created: number; ops: number }> }> };
      for (const [scope, breakdown] of Object.entries(payload.breakdowns)) {
        const totals = breakdown.byApp.map((entry) => entry.created + entry.ops);
        expect(totals, `${name} ${scope}`).toEqual([...totals].sort((a, b) => b - a));
        expect(breakdown.byApp.length, `${name} ${scope}`).toBeLessThanOrEqual(10);
      }
    }
    // mainnet, all history: the chain's top integrators (independent recount), Seedless among them
    const all = read('dashboard-mainnet-all.json') as { breakdowns: { cluster: { byApp: Array<{ app: string }> } } };
    expect(all.breakdowns.cluster.byApp.slice(0, 4).map((entry) => entry.app)).toEqual([
      'portal.lazor.sh', 'api-wallet.appw1.tradestrike.io', 'www.seedlesslabs.xyz', 'wallet.tradestrike.io',
    ]);
  });

  it('latest holds the newest 50 per program, newest first', () => {
    for (const name of names) {
      const payload = read(name) as { latest: Array<{ programKey: number; blockTime: string }> };
      const perProgram = new Map<number, number>();
      for (const row of payload.latest) perProgram.set(row.programKey, (perProgram.get(row.programKey) ?? 0) + 1);
      for (const count of perProgram.values()) expect(count).toBeLessThanOrEqual(50);
      const times = payload.latest.map((row) => Date.parse(row.blockTime));
      expect(times).toEqual([...times].sort((a, b) => b - a));
    }
    // devnet: v2 dominates recent traffic, yet the v1 rows are there for the v1 filter
    const devnet = read('dashboard-devnet-7d.json') as { latest: Array<{ version: number }> };
    expect(devnet.latest.filter((row) => row.version === 1).length).toBeGreaterThan(0);
  });

  it('the previous period ends exactly one period before the request time', () => {
    const period: Record<string, number> = { '24h': 24, '7d': 168, '30d': 720 };
    for (const name of names) {
      const payload = read(name) as { window: string; generatedAt: string; range: { previousEnd: string | null } };
      if (payload.window === 'all') {
        expect(payload.range.previousEnd).toBeNull();
      } else {
        expect(Date.parse(payload.generatedAt) - Date.parse(payload.range.previousEnd as string)).toBe(period[payload.window] * 3600e3);
      }
    }
  });

  it('setup-required.json is the clean "backend upgrade pending" payload', () => {
    const payload = read('setup-required.json');
    expect(validateDashboardPayload(payload)).toEqual([]);
    expect(payload).toMatchObject({ freshness: { state: 'setup_required' }, programs: [] });
  });

  it('health.json lists the four programs', () => {
    const health = read('health.json') as { programs: unknown[]; status: string };
    expect(health.programs).toHaveLength(4);
    expect(['live', 'catching_up', 'delayed', 'stale']).toContain(health.status);
  });
});
