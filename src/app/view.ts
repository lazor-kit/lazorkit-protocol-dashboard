// Turns a fetch result into what the page renders (pure; unit-tested).

import type { DashboardResult } from '../api/fetchDashboard';
import type { DashboardPayload, Freshness } from '../types/dashboard';
import { selectBanner, type BannerModel } from './selectors';

export type DashboardView =
  | { kind: 'loading' }
  | { kind: 'data'; payload: DashboardPayload; banner: BannerModel | null; cachedAt: string | null }
  | { kind: 'setup_required'; payload: DashboardPayload; banner: BannerModel }
  | { kind: 'unavailable'; banner: BannerModel; freshness: Freshness }
  | { kind: 'error'; message: string };

const UNAVAILABLE_FRESHNESS: Freshness = {
  state: 'unavailable',
  completeThrough: null,
  lastWorkerRunAt: null,
  lastWorkerTrigger: null,
  workflow: { state: 'unknown', checkedAt: null, lastScheduledRunAt: null, lastConclusion: null },
  reasons: [],
  catchUp: [],
};

export function viewFromResult(result: DashboardResult | null, now: number): DashboardView {
  if (!result) return { kind: 'loading' };
  if (result.kind === 'ok') {
    const payload = result.payload;
    return { kind: 'data', payload, banner: selectBanner({ freshness: payload.freshness, programs: payload.programs, now }), cachedAt: null };
  }
  if (result.kind === 'setup_required') {
    const banner = selectBanner({ freshness: result.payload.freshness, programs: [], now });
    return { kind: 'setup_required', payload: result.payload, banner: banner! };
  }
  if (result.kind === 'unavailable' || (result.kind === 'error' && result.cached)) {
    const cached = result.cached;
    if (cached) {
      const freshness: Freshness = { ...cached.payload.freshness, state: 'unavailable' };
      const payload: DashboardPayload = { ...cached.payload, freshness };
      const banner = selectBanner({ freshness, programs: payload.programs, now, cachedAt: cached.savedAt });
      return { kind: 'data', payload, banner, cachedAt: cached.savedAt };
    }
    if (result.kind === 'unavailable') {
      return { kind: 'unavailable', freshness: UNAVAILABLE_FRESHNESS, banner: selectBanner({ freshness: UNAVAILABLE_FRESHNESS, programs: [], now })! };
    }
  }
  return { kind: 'error', message: result.kind === 'error' ? result.message : 'Unable to load the dashboard.' };
}
