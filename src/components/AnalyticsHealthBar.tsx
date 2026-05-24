import type { DashboardStats } from '../solana/dashboardTypes';
import type { ClusterId } from '../solana/constants';
import { CLUSTERS } from '../solana/constants';
import { formatDateTime } from '../solana/format';

export function AnalyticsHealthBar({
  stats,
  cluster,
}: {
  stats: DashboardStats | null;
  cluster: ClusterId;
}) {
  return (
    <section className="statusBar analyticsHealthBar" aria-label="Analytics health">
      <Info label="Network" value={CLUSTERS[cluster].label} />
      <Info
        label="Protocol"
        value={stats ? formatProtocolStatus(stats.health.protocolStatus) : 'Loading'}
      />
      <Info
        label="Analytics"
        value={stats ? formatAnalyticsStatus(stats) : 'Loading'}
        tone={stats ? toneForStatus(stats.health.analyticsStatus) : undefined}
      />
      <Info
        label="Coverage"
        value={stats?.health.dataCoverageLabel ?? 'Loading'}
      />
      <Info
        label="Last Indexed"
        value={
          stats?.health.newestIndexedAt
            ? formatDateTime(stats.health.newestIndexedAt)
            : stats?.setupRequired
              ? 'Setup required'
              : 'No indexed data'
        }
      />
    </section>
  );
}

function Info({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'good' | 'warn' | 'bad';
}) {
  return (
    <div className="statusItem">
      <span>{label}</span>
      <strong className={tone ? `statusTone-${tone}` : undefined} title={value}>
        {value}
      </strong>
    </div>
  );
}

function formatProtocolStatus(
  status: DashboardStats['health']['protocolStatus'],
): string {
  if (status === 'enabled') return 'Enabled';
  if (status === 'paused') return 'Paused';
  return 'Not initialized';
}

function formatAnalyticsStatus(stats: DashboardStats): string {
  const { health } = stats;
  if (health.analyticsStatus === 'fresh') return 'Fresh';
  if (health.analyticsStatus === 'partial') return 'Backfilling';
  if (health.analyticsStatus === 'indexing') return 'Indexing';
  if (health.analyticsStatus === 'stale') return 'Stale data';
  if (health.analyticsStatus === 'error') {
    return health.lastRunWarningsCount > 0
      ? `Error, ${health.lastRunWarningsCount} warning${health.lastRunWarningsCount === 1 ? '' : 's'}`
      : 'Indexer error';
  }
  if (health.analyticsStatus === 'not_configured') return 'Not configured';
  return 'No indexed data';
}

function toneForStatus(
  status: DashboardStats['health']['analyticsStatus'],
): 'good' | 'warn' | 'bad' | undefined {
  if (status === 'fresh') return 'good';
  if (status === 'partial' || status === 'indexing' || status === 'stale') return 'warn';
  if (status === 'error') return 'bad';
  return undefined;
}
