import type { ReactNode } from 'react';
import type { Delta } from '../app/selectors';

/** One overview number: the value, an optional "v1 · v2" split, a delta against the previous period, a sub-line. */
export function KpiCard({
  label,
  value,
  title,
  delta,
  deltaLabel,
  split,
  sub,
  loading = false,
}: {
  label: string;
  value: string;
  title?: string;
  delta?: Delta | null;
  deltaLabel?: string;
  split?: ReactNode;
  sub?: ReactNode;
  loading?: boolean;
}) {
  return (
    <article className="kpiCard">
      <span className="kpiLabel">{label}</span>
      <strong className={loading ? 'kpiValue skeletonText' : 'kpiValue'} title={title}>
        {value}
      </strong>
      {delta && delta.direction !== 'none' ? (
        <span className="kpiDelta">
          <span className={`trendValue trend-${delta.direction}`}>
            {delta.direction === 'up' ? '▲ ' : delta.direction === 'down' ? '▼ ' : ''}
            {delta.label}
          </span>{' '}
          {deltaLabel}
        </span>
      ) : deltaLabel && !delta ? (
        <span className="kpiDelta">{deltaLabel}</span>
      ) : null}
      {split ? <span className="kpiSplit">{split}</span> : null}
      {sub ? <span className="kpiSub">{sub}</span> : null}
    </article>
  );
}
