// Payload fixtures captured from the local API after a full backfill (see api/payloadFixtures.test.ts).
import type { DashboardPayload } from '../types/dashboard';
import devnet24h from '../types/__fixtures__/dashboard-devnet-24h.json';
import devnet30d from '../types/__fixtures__/dashboard-devnet-30d.json';
import devnet7d from '../types/__fixtures__/dashboard-devnet-7d.json';
import devnetAll from '../types/__fixtures__/dashboard-devnet-all.json';
import mainnet24h from '../types/__fixtures__/dashboard-mainnet-24h.json';
import mainnet30d from '../types/__fixtures__/dashboard-mainnet-30d.json';
import mainnet7d from '../types/__fixtures__/dashboard-mainnet-7d.json';
import mainnetAll from '../types/__fixtures__/dashboard-mainnet-all.json';
import setupRequired from '../types/__fixtures__/setup-required.json';

const asPayload = (value: unknown) => structuredClone(value) as DashboardPayload;

export const FIXTURES: Record<string, () => DashboardPayload> = {
  'mainnet-24h': () => asPayload(mainnet24h),
  'mainnet-7d': () => asPayload(mainnet7d),
  'mainnet-30d': () => asPayload(mainnet30d),
  'mainnet-all': () => asPayload(mainnetAll),
  'devnet-24h': () => asPayload(devnet24h),
  'devnet-7d': () => asPayload(devnet7d),
  'devnet-30d': () => asPayload(devnet30d),
  'devnet-all': () => asPayload(devnetAll),
};

export const setupRequiredPayload = () => asPayload(setupRequired);

/** 20 minutes after the fixtures were captured. */
export const FIXTURE_NOW = Date.parse('2026-10-01T21:50:00Z');
