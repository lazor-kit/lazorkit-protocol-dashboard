import type { LucideIcon } from 'lucide-react';

export function MetricCard({
  label,
  value,
  detail,
  icon: Icon,
  isLoading = false,
}: {
  label: string;
  value: string;
  detail: string;
  icon: LucideIcon;
  isLoading?: boolean;
}) {
  return (
    <article className="metricCard">
      <div className="metricIcon" aria-hidden="true">
        <Icon size={17} />
      </div>
      <div className="metricContent">
        <span>{label}</span>
        <strong className={isLoading ? 'skeletonText' : undefined}>{value}</strong>
        <small>{detail}</small>
      </div>
    </article>
  );
}

