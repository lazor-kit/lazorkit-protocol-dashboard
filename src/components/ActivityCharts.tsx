import { useMemo } from 'react';
import type { DashboardPayload } from '../types/dashboard';
import { chartRows, kpisFor, scopeForVersion, type BinSize } from '../app/selectors';
import type { VersionFilter } from '../app/urlState';
import { formatInteger, formatLamports } from '../lib/format';
import { ChartPanel } from './ChartPanel';

const PER: Record<BinSize, string> = { hour: 'Per hour', day: 'Per day', week: 'Per week', month: 'Per month' };

function stackNote(version: VersionFilter): string {
  return version === 'all' ? ', stacked by protocol version' : version === '1' ? ', protocol v1' : ', protocol v2';
}

/** Section 5: activity over time. */
export function ActivityCharts({ payload, version }: { payload: DashboardPayload; version: VersionFilter }) {
  const txs = useMemo(() => chartRows(payload, 'txs', version), [payload, version]);
  const created = useMemo(() => chartRows(payload, 'walletsCreated', version), [payload, version]);
  const active = useMemo(() => chartRows(payload, 'activeWallets', version), [payload, version]);
  const fees = useMemo(() => chartRows(payload, 'fees', version), [payload, version]);
  const kpis = kpisFor(payload, scopeForVersion(payload.cluster, version))?.current;
  const rebinned = payload.window === 'all' ? ' (all history re-binned)' : '';
  const sum = (rows: typeof txs.rows, key: 'total' | 'failed') => rows.reduce((total, row) => total + row[key], 0);

  return (
    <section className="chartsGrid" aria-label="Activity over time">
      <ChartPanel
        title="Transactions"
        subtitle={`${PER[txs.size]}${stackNote(version)}${rebinned}; the line is failed transactions`}
        rows={txs.rows}
        size={txs.size}
        kind="count"
        version={version}
        showFailed
        totalLabel="All versions (de-duplicated)"
        summary={`${formatInteger(kpis?.txs ?? sum(txs.rows, 'total'))} total · ${formatInteger(kpis?.txsFailed ?? sum(txs.rows, 'failed'))} failed`}
      />
      <ChartPanel
        title="Wallets created"
        subtitle={`${PER[created.size]}${stackNote(version)}${rebinned}`}
        rows={created.rows}
        size={created.size}
        kind="count"
        version={version}
        summary={`${formatInteger(kpis?.walletsCreated ?? sum(created.rows, 'total'))} created`}
      />
      <ChartPanel
        title="Active wallets"
        subtitle={`Distinct wallets ${active.size === 'hour' ? 'per hour' : 'per day'}${stackNote(version)}; distinct counts are never summed across ${active.size === 'hour' ? 'hours' : 'days'}`}
        rows={active.rows}
        size={active.size}
        kind="count"
        version={version}
        summary={`${formatInteger(kpis?.activeWallets ?? 0)} distinct in window`}
      />
      <ChartPanel
        title="Protocol fees"
        subtitle={`${PER[fees.size]}${stackNote(version)}${rebinned}; SOL paid to treasury shards`}
        rows={fees.rows}
        size={fees.size}
        kind="lamports"
        version={version}
        summary={formatLamports(kpis?.feeLamports ?? '0')}
      />
    </section>
  );
}
