import type { DashboardStats } from '../solana/dashboardTypes';
import { formatDateTime } from '../solana/format';

export function AnalyticsHealthBar({ stats }: { stats: DashboardStats | null }) {
  return (
    <section className="statusBar analyticsHealthBar" aria-label="Analytics health">
      <Info label="Protocol" value={stats?.health.protocolStatus ?? 'Loading'} />
      <Info
        label="Last Indexed"
        value={
          stats?.health.lastIndexedAt
            ? formatDateTime(stats.health.lastIndexedAt)
            : stats?.setupRequired
              ? 'Setup required'
              : 'No cursor'
        }
      />
      <Info
        label="Indexed Slot"
        value={
          stats?.health.lastIndexedSlot === null ||
          stats?.health.lastIndexedSlot === undefined
            ? 'None'
            : stats.health.lastIndexedSlot.toLocaleString()
        }
      />
      <Info
        label="Cache"
        value={
          stats
            ? `${stats.health.cacheHit ? 'Hit' : 'Fresh'} / ${stats.health.cacheTtlSeconds}s`
            : 'Loading'
        }
      />
    </section>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="statusItem">
      <span>{label}</span>
      <strong title={value}>{value}</strong>
    </div>
  );
}
