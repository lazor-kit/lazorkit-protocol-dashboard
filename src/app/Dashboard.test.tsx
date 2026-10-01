// Server-renders the whole page body for every payload fixture and every freshness state (no DOM library needed).
import { renderToStaticMarkup } from 'react-dom/server';
import type { DashboardPayload } from '../types/dashboard';
import { FIXTURE_NOW, FIXTURES, setupRequiredPayload } from '../test/fixtures';
import { Dashboard } from './Dashboard';
import type { VersionFilter } from './urlState';
import { viewFromResult } from './view';

const render = (payload: DashboardPayload, version: VersionFilter = 'all', expandAll = false) =>
  renderToStaticMarkup(
    <Dashboard view={viewFromResult({ kind: 'ok', payload, problems: [] }, FIXTURE_NOW)} version={version} now={FIXTURE_NOW} expandAll={expandAll} />,
  );
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

describe('Dashboard renders every fixture', () => {
  for (const [name, load] of Object.entries(FIXTURES)) {
    for (const version of ['all', '1', '2'] as const) {
      it(`${name}, version ${version}`, () => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const html = render(load(), version, true);
        expect(html.length).toBeGreaterThan(1000);
        expect(errors).not.toHaveBeenCalled();
        errors.mockRestore();
      });
    }
  }

  it('mainnet: v2 is "not deployed yet" with the expected build, and nothing errors', () => {
    const page = text(render(FIXTURES['mainnet-30d']()));
    expect(page).toContain('Not deployed yet');
    expect(page).toContain('LazorFroi… has no account on mainnet. It will be picked up automatically on its first deploy');
    expect(page).toContain('4cb80304…');
    expect(page).toContain('Phase B: v1 sunset');
    expect(page).toContain('Migration has not started: v1 still runs the full v1 build');
    expect(page).toContain('930,000 lamports');
    expect(page).not.toContain('Data status:');
  });

  it('mainnet with the v2 filter shows the not-deployed state instead of zero KPIs', () => {
    const page = text(render(FIXTURES['mainnet-30d'](), '2'));
    expect(page).toContain('Protocol v2 is not deployed on mainnet yet');
    expect(page).not.toContain('Latest activity');
  });

  it('devnet: v2 figures, SIMD-0385 share, release match and fees not configured', () => {
    const html = render(FIXTURES['devnet-7d'](), '2');
    const page = text(html);
    expect(page).toContain('v2 devnet');
    expect(page).toContain('Transaction v1 (SIMD-0385)');
    expect(page).toContain('✓ matches release-hashes.txt · devnet');
    expect(page).toContain('Fees not configured');
    expect(html).toMatch(/href="https:\/\/explorer\.solana\.com\/tx\/[1-9A-HJ-NP-Za-km-z]{60,90}\?cluster=devnet"/);
  });

  it('explorer links on mainnet carry no cluster parameter', () => {
    const html = render(FIXTURES['mainnet-7d']());
    expect(html).toContain('https://explorer.solana.com/tx/');
    expect(html).not.toContain('cluster=devnet');
  });

  it('an active migration renders progress, the per-day chart and leftovers', () => {
    const payload = FIXTURES['mainnet-all']();
    payload.migration = {
      ...payload.migration!,
      status: 'active',
      v1BinaryKind: 'v1-sunset',
      totals: { migrations: 46, migratedLamports: '1500000000', tokenAccounts: 12 },
      series: [
        { day: '2026-11-02', migrations: 30 },
        { day: '2026-11-04', migrations: 16 },
      ],
      v1WalletsRemaining: 138,
      percentMigrated: 25,
      v2WalletsFromMigration: 46,
      v2WalletsNew: 3,
      retiredCalls: 7,
    };
    payload.programs[0].deployment.binaryKind = 'v1-sunset';
    const page = text(render(payload));
    expect(page).toContain('In progress');
    expect(page).toContain('25%');
    expect(page).toContain('46 of 184 v1 wallets');
    expect(page).toContain('1.5 SOL');
    expect(page).toContain('Retired: migration only');
    expect(page).toContain('Migrations per day');
  });
});

describe('Dashboard states', () => {
  it('setup required: banner and an empty state, never an error page', () => {
    const view = viewFromResult({ kind: 'setup_required', payload: setupRequiredPayload() }, FIXTURE_NOW);
    const page = text(renderToStaticMarkup(<Dashboard view={view} version="all" now={FIXTURE_NOW} />));
    expect(page).toContain('Backend upgrade pending');
    expect(page).toContain('Production data is unaffected');
    expect(page).not.toContain('Unable to load');
  });

  it('unavailable with a saved copy shows the copy under a red banner', () => {
    const cached = { savedAt: '2026-10-01T18:00:00Z', payload: FIXTURES['mainnet-30d']() };
    const view = viewFromResult({ kind: 'unavailable', detail: 'down', cached }, FIXTURE_NOW);
    expect(view.kind).toBe('data');
    const page = text(renderToStaticMarkup(<Dashboard view={view} version="all" now={FIXTURE_NOW} />));
    expect(page).toContain('Unavailable');
    expect(page).toContain('Showing the copy saved in this browser from 2026-10-01 18:00 UTC');
    expect(page).toContain('Transactions');
  });

  it('unavailable without a copy explains there is nothing to show', () => {
    const view = viewFromResult({ kind: 'unavailable', detail: 'down', cached: null }, FIXTURE_NOW);
    const page = text(renderToStaticMarkup(<Dashboard view={view} version="all" now={FIXTURE_NOW} />));
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
    const page = text(renderToStaticMarkup(<Dashboard view={view} version="all" now={FIXTURE_NOW} onRetry={() => undefined} />));
    expect(page).toContain('Unable to load the dashboard');
    expect(page).toContain('Retry');
  });
});
