// Server-renders the whole page body for every payload fixture and every freshness state (no DOM library needed).
import { renderToStaticMarkup } from 'react-dom/server';
import type { DashboardPayload } from '../types/dashboard';
import { FIXTURE_NOW, FIXTURES, setupRequiredPayload } from '../test/fixtures';
import { Dashboard } from './Dashboard';
import { protocolPayload } from '../lib/protocolScope';
import { viewFromResult } from './view';

const render = (payload: DashboardPayload, expandAll = false) =>
  renderToStaticMarkup(
    <Dashboard view={viewFromResult({ kind: 'ok', payload: protocolPayload(payload), problems: [] }, FIXTURE_NOW)} now={FIXTURE_NOW} expandAll={expandAll} />,
  );
const ENTITIES: Record<string, string> = { amp: '&', quot: '"', lt: '<', gt: '>', '#x27': "'" };
// Tags to spaces, then entities decoded in one pass (so "&amp;lt;" stays "&lt;"), then whitespace collapsed.
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(amp|quot|lt|gt|#x27);/g, (_, entity: string) => ENTITIES[entity])
    .replace(/\s+/g, ' ');

describe('Dashboard renders every fixture', () => {
  for (const [name, load] of Object.entries(FIXTURES)) {
    it(name, () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const html = render(load(), true);
        expect(html.length).toBeGreaterThan(1000);
        expect(html.match(/LazorFroi|57bTNWqt|Migration has not started/i)?.[0]).toBeUndefined();
        expect(text(html).match(/\bv2\b/i)?.[0]).toBeUndefined();
        expect(errors).not.toHaveBeenCalled();
      } finally {
        errors.mockRestore();
      }
    });
  }

  it('shows current Protocol metrics and separates expired account types', () => {
    const page = text(render(FIXTURES['mainnet-30d']()));
    expect(page).toContain('930,000 lamports');
    expect(page).toContain('Expired sessions');
    expect(page).toContain('Expired deferred approvals');
    expect(page).toContain('Rent held by expired approvals');
    expect(page).not.toContain('Data status:');
  });

  it('devnet shows recent Protocol activity and cluster-specific Explorer links', () => {
    const html = render(FIXTURES['devnet-7d']());
    const page = text(html);
    expect(page).toContain('Latest activity');
    expect(page).toContain('Newest 50 with a LazorKit instruction');
    expect(page).toContain('Transaction v1 (SIMD-0385)');
    expect(html).toMatch(/href="https:\/\/explorer\.solana\.com\/tx\/[1-9A-HJ-NP-Za-km-z]{60,90}\?cluster=devnet"/);
  });

  it('a version without recent transactions says when its last one was, not that nothing was indexed', () => {
    const payload = FIXTURES['devnet-7d']();
    payload.latest = payload.latest.filter((row) => row.version !== 1);
    const page = text(render(payload));
    expect(page).toContain('No recent transactions');
    expect(page).toContain('The newest one was');
    expect(page).toContain('older activity is counted in the figures above');
    expect(page).not.toContain('after the indexer has ingested them');
  });

  it('explorer links on mainnet carry no cluster parameter', () => {
    const html = render(FIXTURES['mainnet-7d']());
    expect(html).toContain('https://explorer.solana.com/tx/');
    expect(html).not.toContain('cluster=devnet');
  });


});

describe('Dashboard states', () => {
  it('setup required: banner and an empty state, never an error page', () => {
    const view = viewFromResult({ kind: 'setup_required', payload: setupRequiredPayload() }, FIXTURE_NOW);
    const page = text(renderToStaticMarkup(<Dashboard view={view} now={FIXTURE_NOW} />));
    expect(page).toContain('Backend upgrade pending');
    expect(page).toContain('Production data is unaffected');
    expect(page).not.toContain('Unable to load');
  });

  it('unavailable with a saved copy shows the copy under a red banner', () => {
    const cached = { savedAt: '2026-10-01T18:00:00Z', payload: FIXTURES['mainnet-30d']() };
    const view = viewFromResult({ kind: 'unavailable', detail: 'down', cached }, FIXTURE_NOW);
    expect(view.kind).toBe('data');
    const page = text(renderToStaticMarkup(<Dashboard view={view} now={FIXTURE_NOW} />));
    expect(page).toContain('Unavailable');
    expect(page).toContain('Showing the copy saved in this browser from 2026-10-01 18:00 UTC');
    expect(page).toContain('Transactions');
  });

  it('unavailable without a copy explains there is nothing to show', () => {
    const view = viewFromResult({ kind: 'unavailable', detail: 'down', cached: null }, FIXTURE_NOW);
    const page = text(renderToStaticMarkup(<Dashboard view={view} now={FIXTURE_NOW} />));
    expect(page).toContain('no copy saved in this browser');
  });

  it('stale with the workflow disabled shows the maintainer command', () => {
    const payload = FIXTURES['mainnet-30d']();
    payload.freshness = {
      ...payload.freshness,
      state: 'stale',
      workflow: { state: 'disabled_inactivity', checkedAt: '2026-10-01T12:17:00Z', lastScheduledRunAt: '2026-07-22T23:52:00Z', lastConclusion: 'success' },
    };
    const page = text(render(payload));
    expect(page).toContain('The indexer has stopped.');
    expect(page).toContain('gh workflow enable indexer.yml');
  });

  it('developer details say what started the last indexer run, and tolerate payloads without it', () => {
    const payload = FIXTURES['mainnet-30d']();
    payload.freshness = { ...payload.freshness, lastWorkerTrigger: 'repository_dispatch' };
    expect(text(render(payload, true))).toContain('Last run started by external cron (repository_dispatch)');
    const older = FIXTURES['mainnet-30d']();
    delete (older.freshness as Partial<typeof older.freshness>).lastWorkerTrigger; // a payload saved before the field existed
    expect(text(render(older, true))).toContain('Last run started by –');
  });

  it('before the first indexer run every program is "not checked yet", never "not deployed"', () => {
    const payload = FIXTURES['mainnet-30d']();
    for (const program of payload.programs) {
      program.deployment = { ...program.deployment, status: 'unknown', binaryKind: null, releaseMatch: null, sha256: null };
      program.state = null;
    }
    const page = text(render(payload));
    expect(page).toContain('Waiting for the first indexer run');
    expect(page).toContain('Not checked yet');
    expect(page).not.toContain('has no account on mainnet');
  });

  it('errors offer a retry', () => {
    const view = viewFromResult({ kind: 'error', message: 'The dashboard API answered HTTP 500.', cached: null }, FIXTURE_NOW);
    const page = text(renderToStaticMarkup(<Dashboard view={view} now={FIXTURE_NOW} onRetry={() => undefined} />));
    expect(page).toContain('Unable to load the dashboard');
    expect(page).toContain('Retry');
  });
});
