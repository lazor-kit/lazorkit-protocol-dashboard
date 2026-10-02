import type { Freshness, ProgramView } from '../types/dashboard';
import { FIXTURE_NOW, FIXTURES } from '../test/fixtures';
import {
  binSizeFor,
  binStart,
  chartRows,
  expectedNextBinary,
  kpiDelta,
  programBadge,
  releaseMatchLabel,
  scopeForVersion,
  selectBanner,
  stateSummary,
  versionSplit,
} from './selectors';

const baseFreshness = (overrides: Partial<Freshness>): Freshness => ({
  state: 'live',
  completeThrough: '2026-10-01T14:05:00Z',
  lastWorkerRunAt: '2026-10-01T18:40:00Z',
  workflow: { state: 'active', checkedAt: '2026-10-01T12:17:00Z', lastScheduledRunAt: null, lastConclusion: null },
  reasons: [],
  catchUp: [],
  ...overrides,
});

describe('selectBanner (spec §10.3 / §11.2 copy)', () => {
  const programs = FIXTURES['mainnet-30d']().programs;
  const devnetPrograms = FIXTURES['devnet-30d']().programs;

  it('shows nothing when live', () => {
    expect(selectBanner({ freshness: baseFreshness({}), programs, now: FIXTURE_NOW })).toBeNull();
  });

  it('catching up: backfill progress per program', () => {
    const banner = selectBanner({
      now: FIXTURE_NOW,
      programs: devnetPrograms,
      freshness: baseFreshness({
        state: 'catching_up',
        reasons: [{ code: 'backfill', programKey: 4, detail: '' }],
        catchUp: [{ programKey: 4, pending: 700, ingested: 1190, percent: 62.9 }],
      }),
    });
    expect(banner).toMatchObject({ tone: 'info', label: 'Catching up' });
    expect(banner?.messages).toEqual(['Building history for v2 devnet: 62 % (1,190 of 1,890 transactions). Figures below are partial.']);
  });

  it('catching up: a backlog names the program and how far figures are complete', () => {
    const withThrough = programs.map((program) =>
      program.programKey === 1 ? { ...program, sync: { ...program.sync, completeThrough: '2026-10-01T14:05:00Z' } } : program,
    );
    const banner = selectBanner({
      now: FIXTURE_NOW,
      programs: withThrough,
      freshness: baseFreshness({
        state: 'catching_up',
        reasons: [{ code: 'backlog', programKey: 1, detail: '' }],
        catchUp: [{ programKey: 1, pending: 120, ingested: 1449, percent: 92.3 }],
      }),
    });
    expect(banner?.messages).toEqual(['Catching up: 120 new transactions pending for v1 mainnet. Figures are complete through 14:05 UTC.']);
  });

  it('catching up: a program whose history is still being discovered', () => {
    const banner = selectBanner({
      now: FIXTURE_NOW,
      programs: devnetPrograms,
      freshness: baseFreshness({
        state: 'catching_up',
        reasons: [{ code: 'backfill', programKey: 4, detail: '' }],
        catchUp: [{ programKey: 4, pending: 0, ingested: 0, percent: null }],
      }),
    });
    expect(banner?.messages).toEqual(['Building history for v2 devnet: discovering its transactions. Figures below are partial.']);
  });

  it('catching up: the indexer never ran', () => {
    const banner = selectBanner({
      now: FIXTURE_NOW,
      programs: [],
      freshness: baseFreshness({ state: 'catching_up', lastWorkerRunAt: null, reasons: [{ code: 'never_run', detail: '' }] }),
    });
    expect(banner?.messages[0]).toBe('Catching up: the indexer has not run yet. Figures appear after its first run.');
  });

  it('delayed: names the age of the last run and failing programs', () => {
    const banner = selectBanner({
      now: FIXTURE_NOW,
      programs,
      freshness: baseFreshness({
        state: 'delayed',
        lastWorkerRunAt: '2026-10-01T12:50:00Z',
        reasons: [{ code: 'program_failing', programKey: 1, detail: 'v1 mainnet: 3 failed runs in a row' }],
      }),
    });
    expect(banner).toMatchObject({ tone: 'warning', label: 'Delayed' });
    expect(banner?.messages).toEqual([
      'Updates are delayed. The last indexer run finished 9 h ago; figures are complete through 14:05 UTC.',
      'v1 mainnet: 3 failed runs in a row',
    ]);
  });

  it('stale with the workflow disabled for inactivity gives the fix', () => {
    const banner = selectBanner({
      now: FIXTURE_NOW,
      programs,
      freshness: baseFreshness({
        state: 'stale',
        completeThrough: '2026-07-23T16:03:00Z',
        workflow: { state: 'disabled_inactivity', checkedAt: '2026-10-01T12:17:00Z', lastScheduledRunAt: null, lastConclusion: null },
      }),
    });
    expect(banner).toMatchObject({ tone: 'danger', label: 'Stale', command: 'gh workflow enable indexer.yml' });
    expect(banner?.messages[0]).toBe('The indexer has stopped. Figures are as of 2026-07-23 16:03 UTC.');
    expect(banner?.messages[1]).toContain('GitHub disabled the scheduled workflow (inactivity)');
  });

  it('stale without a workflow signal says when the last run finished', () => {
    const banner = selectBanner({
      now: FIXTURE_NOW,
      programs,
      freshness: baseFreshness({ state: 'stale', lastWorkerRunAt: '2026-09-29T19:17:00Z', workflow: { state: 'unknown', checkedAt: null, lastScheduledRunAt: null, lastConclusion: null } }),
    });
    expect(banner?.command).toBeNull();
    expect(banner?.messages[1]).toBe('The last indexer run finished 2 days ago.');
  });

  it('unavailable mentions the saved copy, or its absence', () => {
    const freshness = baseFreshness({ state: 'unavailable' });
    expect(selectBanner({ freshness, programs, now: FIXTURE_NOW, cachedAt: '2026-10-01T20:33:00Z' })?.messages[0]).toBe(
      'Data service unavailable (the database may be paused). Showing the copy saved in this browser from 2026-10-01 20:33 UTC (1.3 h ago).',
    );
    expect(selectBanner({ freshness, programs, now: FIXTURE_NOW, cachedAt: null })?.messages[0]).toContain('no copy saved in this browser');
  });

  it('setup required is amber and reassures about production', () => {
    const banner = selectBanner({ freshness: baseFreshness({ state: 'setup_required' }), programs: [], now: FIXTURE_NOW });
    expect(banner).toMatchObject({ tone: 'warning', label: 'Setup required' });
    expect(banner?.messages[0]).toBe(
      'Backend upgrade pending: the database migration for this version has not been applied yet. Production data is unaffected.',
    );
  });
});

describe('KPI helpers', () => {
  it('kpiDelta', () => {
    expect(kpiDelta(467, 195)).toEqual({ label: '+139%', direction: 'up' });
    expect(kpiDelta(59, 38)).toEqual({ label: '+55.3%', direction: 'up' });
    expect(kpiDelta(10, 20)).toEqual({ label: '−50%', direction: 'down' });
    expect(kpiDelta(1399, 2)).toEqual({ label: '×700', direction: 'up' });
    expect(kpiDelta(90, 10)).toEqual({ label: '+800%', direction: 'up' });
    expect(kpiDelta(0, 0)).toEqual({ label: '0%', direction: 'flat' });
    expect(kpiDelta(3, 0)).toEqual({ label: 'new', direction: 'up' });
    expect(kpiDelta(3, null)).toEqual({ label: '', direction: 'none' });
  });

  it('maps the version filter to a KPI scope', () => {
    expect(scopeForVersion('mainnet', 'all')).toBe('cluster');
    expect(scopeForVersion('mainnet', '1')).toBe('1');
    expect(scopeForVersion('mainnet', '2')).toBe('2');
    expect(scopeForVersion('devnet', '1')).toBe('3');
    expect(scopeForVersion('devnet', '2')).toBe('4');
  });

  it('splits by version and sums state over deployed programs', () => {
    const mainnet = FIXTURES['mainnet-30d']();
    expect(versionSplit(mainnet, (k) => k.txs)).toEqual({ v1: 467, v2: 0 });
    const state = stateSummary(mainnet, 'all');
    expect(state.wallets).toBe(184);
    expect(state.vaultLamports).toBe(5_934_333_867n);
    expect(state.perVersion.v2).toBeNull();

    const devnet = FIXTURES['devnet-30d']();
    expect(stateSummary(devnet, 'all').wallets).toBe(110 + 127);
    expect(stateSummary(devnet, '2').wallets).toBe(127);
    expect(stateSummary(devnet, '1').vaultLamports).toBe(72_280_712_197n);
  });
});

describe('programs and binaries', () => {
  const mainnet = FIXTURES['mainnet-30d']();
  const devnet = FIXTURES['devnet-30d']();
  const v1 = mainnet.programs.find((p) => p.programKey === 1)!;
  const v2 = mainnet.programs.find((p) => p.programKey === 2)!;
  const devV2 = devnet.programs.find((p) => p.programKey === 4)!;
  const withDeployment = (program: ProgramView, deployment: Partial<ProgramView['deployment']>, sync: Partial<ProgramView['sync']> = {}): ProgramView => ({
    ...program,
    deployment: { ...program.deployment, ...deployment },
    sync: { ...program.sync, ...sync },
  });

  it('badges', () => {
    expect(programBadge(v1, FIXTURE_NOW).label).toBe('Live');
    expect(programBadge(withDeployment(v1, {}, { backfillComplete: false }), FIXTURE_NOW).label).toBe('Building history');
    expect(programBadge(withDeployment(v2, { status: 'unknown' }), FIXTURE_NOW).label).toBe('Not checked yet');
    expect(programBadge(v2, FIXTURE_NOW).label).toBe('Not deployed yet');
    expect(programBadge(withDeployment(v1, { binaryKind: 'v1-sunset' }), FIXTURE_NOW).label).toBe('Retired: migration only');
    expect(programBadge(withDeployment(v1, { binaryKind: 'unknown', releaseMatch: null }), FIXTURE_NOW).label).toBe('Unrecognised build');
    expect(programBadge(withDeployment(v1, {}, { lastActivityAt: '2026-08-31T00:00:00Z' }), FIXTURE_NOW).label).toBe('Dormant');
    expect(programBadge(withDeployment(v1, { status: 'closed' }), FIXTURE_NOW).label).toBe('Closed');
  });

  it('expected next build', () => {
    expect(expectedNextBinary(v1, mainnet.binaries)?.binary.sha256.slice(0, 8)).toBe('6080da9f');
    expect(expectedNextBinary(v2, mainnet.binaries)?.binary.sha256.slice(0, 8)).toBe('4cb80304');
    expect(expectedNextBinary(devV2, devnet.binaries)).toBeNull();
    expect(expectedNextBinary(withDeployment(v1, { binaryKind: 'v1-sunset' }), mainnet.binaries)).toBeNull();
  });

  it('release match labels', () => {
    expect(releaseMatchLabel(devV2)).toMatchObject({ text: '✓ matches release-hashes.txt · devnet', ok: true });
    expect(releaseMatchLabel(v1).text).toBe('✓ matches program dump: v1 (mainnet build 2026-04-29)');
    expect(releaseMatchLabel(withDeployment(v1, { releaseMatch: null })).ok).toBe(false);
    expect(releaseMatchLabel(v2).ok).toBeNull();
  });
});

describe('series', () => {
  it('chooses bucket sizes', () => {
    expect(binSizeFor('24h', 1)).toBe('hour');
    expect(binSizeFor('30d', 30)).toBe('day');
    expect(binSizeFor('all', 155)).toBe('week');
    expect(binSizeFor('all', 181)).toBe('month');
  });

  it('re-bins to ISO weeks (Monday) and months', () => {
    expect(binStart('2026-10-01', 'week')).toBe('2026-09-28');
    expect(binStart('2026-09-28', 'week')).toBe('2026-09-28');
    expect(binStart('2026-09-27', 'week')).toBe('2026-09-21');
    expect(binStart('2026-09-27', 'month')).toBe('2026-09-01');
    expect(binStart('2026-10-01T05:00:00Z', 'hour')).toBe('2026-10-01T05:00:00Z');
  });

  for (const name of ['mainnet-all', 'mainnet-30d', 'devnet-all', 'devnet-7d', 'devnet-24h']) {
    it(`${name}: re-binned totals equal the window KPIs`, () => {
      const payload = FIXTURES[name]();
      const { rows, size } = chartRows(payload, 'txs', 'all');
      const kpis = payload.kpis.cluster!.current;
      expect(rows.reduce((sum, row) => sum + row.total, 0)).toBe(kpis.txs);
      expect(rows.reduce((sum, row) => sum + row.failed, 0)).toBe(kpis.txsFailed);
      if (payload.window === 'all') expect(size).toBe('week');
      const fees = chartRows(payload, 'fees', 'all').rows.reduce((sum, row) => sum + row.total, 0);
      expect(BigInt(fees)).toBe(BigInt(kpis.feeLamports));
    });
  }

  it('keeps active wallets daily (never sums distinct counts) and follows the version filter', () => {
    const payload = FIXTURES['devnet-all']();
    expect(chartRows(payload, 'activeWallets', 'all').size).toBe('day');
    const v1Only = chartRows(payload, 'txs', '1').rows;
    expect(v1Only.every((row) => row.v2 === 0)).toBe(true);
    expect(v1Only.reduce((sum, row) => sum + row.total, 0)).toBe(payload.kpis['3']!.current.txs);
  });
});
