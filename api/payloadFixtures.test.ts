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
