// Data layer for the SPA (spec §11.1): GET /api/dashboard with the typed payload, plus a per-(cluster, window)
// copy of the last good payload in localStorage. Every storage access is wrapped in try/catch: storage can be
// missing, full, or throw (private windows, blocked site data), and the page must work without it.
//
//   200 + live data       -> { kind: 'ok' }               (cached)
//   200 + setup_required  -> { kind: 'setup_required' }   (banner + empty state, never an error page)
//   503 / network error   -> { kind: 'unavailable' }      (red banner over the cached copy, if any)
//   anything else         -> { kind: 'error' }

import type { Cluster, DashboardPayload, DashboardWindow } from '../types/dashboard';
import { validateDashboardPayload } from '../types/validate';

export interface CachedPayload {
  savedAt: string;
  payload: DashboardPayload;
}

export type DashboardResult =
  | { kind: 'ok'; payload: DashboardPayload; problems: string[] }
  | { kind: 'setup_required'; payload: DashboardPayload }
  | { kind: 'unavailable'; detail: string; cached: CachedPayload | null }
  | { kind: 'error'; message: string; cached: CachedPayload | null };

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const CACHE_PREFIX = 'lk-dashboard:v2:';
const CACHE_INDEX = `${CACHE_PREFIX}index`;
const MAX_CACHED = 4;

export function cacheKey(cluster: Cluster, window: DashboardWindow): string {
  return `${CACHE_PREFIX}${cluster}:${window}`;
}

export function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function readCached(storage: StorageLike | null, cluster: Cluster, window: DashboardWindow): CachedPayload | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(cacheKey(cluster, window));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedPayload;
    if (!parsed || typeof parsed.savedAt !== 'string' || validateDashboardPayload(parsed.payload).length > 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

function readIndex(storage: StorageLike): string[] {
  try {
    const raw = storage.getItem(CACHE_INDEX);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === 'string') : [];
  } catch {
    return [];
  }
}

/** Keeps the newest MAX_CACHED payloads; on a quota error evicts the oldest copy and retries. */
export function writeCached(storage: StorageLike | null, payload: DashboardPayload, savedAt = new Date().toISOString()): boolean {
  if (!storage) return false;
  const key = cacheKey(payload.cluster, payload.window);
  const value = JSON.stringify({ savedAt, payload } satisfies CachedPayload);
  const index = readIndex(storage).filter((entry) => entry !== key);
  const evictOldest = (): boolean => {
    const oldest = index.shift();
    if (oldest === undefined) return false;
    try {
      storage.removeItem(oldest);
    } catch {
      // storage blocked; the retry below fails again and we give up
    }
    return true;
  };
  while (index.length >= MAX_CACHED) evictOldest();
  for (;;) {
    try {
      storage.setItem(key, value);
      storage.setItem(CACHE_INDEX, JSON.stringify([...index, key]));
      return true;
    } catch {
      if (!evictOldest()) return false;
    }
  }
}

export async function fetchDashboard(
  cluster: Cluster,
  window: DashboardWindow,
  options: { fetchImpl?: typeof fetch; storage?: StorageLike | null; signal?: AbortSignal } = {},
): Promise<DashboardResult> {
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const cached = () => readCached(storage, cluster, window);
  const params = new URLSearchParams({ cluster, window });
  let response: Response;
  try {
    // cache: 'no-cache' makes the browser revalidate every time. The API's `stale-while-revalidate` is meant for the
    // CDN; without this a browser may reuse an old response for up to 15 minutes, even after "Refresh".
    response = await (options.fetchImpl ?? fetch)(`/api/dashboard?${params.toString()}`, {
      headers: { accept: 'application/json' },
      cache: 'no-cache',
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    return { kind: 'unavailable', detail: 'The dashboard API could not be reached.', cached: cached() };
  }
  const body = (await response.json().catch(() => null)) as unknown;
  const freshnessState = (body as { freshness?: { state?: string } } | null)?.freshness?.state;
  const firstReason = (body as { freshness?: { reasons?: Array<{ detail?: string }> } } | null)?.freshness?.reasons?.[0]?.detail;

  if (response.status === 503 || freshnessState === 'unavailable') {
    return { kind: 'unavailable', detail: firstReason ?? `The data service answered HTTP ${response.status}.`, cached: cached() };
  }
  if (!response.ok) {
    const message = (body as { error?: string } | null)?.error ?? `The dashboard API answered HTTP ${response.status}.`;
    return { kind: 'error', message, cached: cached() };
  }
  if (freshnessState === 'setup_required') {
    return { kind: 'setup_required', payload: body as DashboardPayload };
  }
  const problems = validateDashboardPayload(body);
  if (problems.length > 0 && !(body && typeof body === 'object' && 'programs' in body && 'kpis' in body)) {
    return { kind: 'error', message: `Unexpected response from the dashboard API (${problems[0]}).`, cached: cached() };
  }
  const payload = body as DashboardPayload;
  if (problems.length === 0) writeCached(storage, payload);
  return { kind: 'ok', payload, problems };
}
