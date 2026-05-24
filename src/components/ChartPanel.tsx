import type { SeriesPoint } from '../solana/dashboardTypes';
import { formatLamportsShort } from '../solana/format';

export function ChartPanel({
  title,
  metric,
  series,
}: {
  title: string;
  metric: 'txCount' | 'uniqueWallets' | 'feesLamports';
  series: SeriesPoint[];
}) {
  const values = series.map((point) =>
    metric === 'feesLamports' ? Number(point.feesLamports) : point[metric],
  );
  const maxValue = Math.max(1, ...values);
  const points = values
    .map((value, index) => {
      const x = series.length <= 1 ? 0 : (index / (series.length - 1)) * 100;
      const y = 56 - (value / maxValue) * 42;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
  const areaPoints = `0,58 ${points} 100,58`;
  const total = values.reduce((sum, value) => sum + value, 0);

  return (
    <section className={`chartPanel chartPanel-${metric}`} aria-label={title}>
      <div className="chartHeader">
        <div>
          <h2>{title}</h2>
        </div>
        <span className="mutedText">
          {metric === 'feesLamports'
            ? formatLamportsShort(BigInt(Math.round(total)))
            : total.toLocaleString()}
        </span>
      </div>
      <svg className="lineChart" viewBox="0 0 100 60" preserveAspectRatio="none">
        <g className="chartGrid" aria-hidden="true">
          {Array.from({ length: 12 }, (_, index) => (
            <line
              key={`v-${index}`}
              x1={index * (100 / 11)}
              x2={index * (100 / 11)}
              y1="0"
              y2="60"
            />
          ))}
          {Array.from({ length: 6 }, (_, index) => (
            <line
              key={`h-${index}`}
              x1="0"
              x2="100"
              y1={index * 12}
              y2={index * 12}
            />
          ))}
        </g>
        <rect className="chartBorder" x="0.3" y="0.3" width="99.4" height="59.4" />
        {metric === 'feesLamports' ? <polygon className="chartArea" points={areaPoints} /> : null}
        <polyline className="chartLine" points={points} />
      </svg>
    </section>
  );
}
