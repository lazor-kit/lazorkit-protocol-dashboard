import type { LucideIcon } from 'lucide-react';

export function KpiCard({
  label,
  value,
  detail,
  percentChange,
  icon: Icon,
  isLoading = false,
}: {
  label: string;
  value: string;
  detail: string;
  percentChange: number | null;
  icon: LucideIcon;
  isLoading?: boolean;
}) {
  const trend = formatTrend(percentChange);
  return (
    <article className="metricCard kpiCard">
      <div className="metricIcon" aria-hidden="true">
        <Icon size={17} />
      </div>
      <div className="metricContent">
        <span>{label}</span>
        <strong className={isLoading ? 'skeletonText' : undefined}>{value}</strong>
        <small>
          <span className={trend.className}>{trend.label}</span>
          {detail}
        </small>
      </div>
    </article>
  );
}

function formatTrend(percentChange: number | null): {
  label: string;
  className: string;
} {
  if (percentChange === null) {
    return { label: 'New ', className: 'trendValue positiveTrend' };
  }
  if (percentChange === 0) {
    return { label: '0% ', className: 'trendValue' };
  }
  const sign = percentChange > 0 ? '+' : '';
  return {
    label: `${sign}${percentChange.toFixed(1)}% `,
    className: percentChange > 0 ? 'trendValue positiveTrend' : 'trendValue',
  };
}
