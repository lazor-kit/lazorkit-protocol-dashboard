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
      const y = 100 - (value / maxValue) * 84 - 8;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
  const total = values.reduce((sum, value) => sum + value, 0);

  return (
    <section className="chartPanel" aria-label={title}>
      <div className="chartHeader">
        <div>
          <p className="eyebrow">Trend</p>
          <h2>{title}</h2>
        </div>
        <span className="mutedText">
          {metric === 'feesLamports'
            ? formatLamportsShort(BigInt(Math.round(total)))
            : total.toLocaleString()}
        </span>
      </div>
      <svg className="lineChart" viewBox="0 0 100 100" preserveAspectRatio="none">
        <polyline points={points} />
      </svg>
    </section>
  );
}
