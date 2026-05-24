import { useState } from 'react';
import type { DashboardWindow, SeriesPoint } from '../solana/dashboardTypes';
import {
  formatInteger,
  formatLamportsShort,
} from '../solana/format';

type ChartMetric = 'txCount' | 'uniqueWallets' | 'feesLamports';

const CHART = {
  left: 10,
  right: 2,
  top: 4,
  bottom: 12,
  width: 88,
  height: 46,
};

export function ChartPanel({
  title,
  metric,
  window,
  series,
}: {
  title: string;
  metric: ChartMetric;
  window: DashboardWindow;
  series: SeriesPoint[];
}) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const model = buildChartModel(series, metric);
  const hoveredPoint =
    hoveredIndex === null ? null : model.points[hoveredIndex] ?? null;
  const hoveredSeriesPoint =
    hoveredIndex === null ? null : series[hoveredIndex] ?? null;

  return (
    <section className={`chartPanel chartPanel-${metric}`} aria-label={title}>
      <div className="chartHeader">
        <div>
          <h2>{title}</h2>
        </div>
        <span className="mutedText">
          {metric === 'feesLamports'
            ? formatLamportsShort(BigInt(Math.round(model.total)))
            : formatInteger(model.total)}
        </span>
      </div>
      <div className="chartCanvas">
        <svg
          className="lineChart"
          viewBox="0 0 100 62"
          preserveAspectRatio="none"
          onPointerMove={(event) => {
            setHoveredIndex(
              getNearestSeriesIndex(
                event.clientX,
                event.currentTarget.getBoundingClientRect(),
                series.length,
              ),
            );
          }}
          onPointerLeave={() => setHoveredIndex(null)}
        >
          <g className="chartGrid" aria-hidden="true">
            {Array.from({ length: 7 }, (_, index) => (
              <line
                key={`v-${index}`}
                x1={CHART.left + index * (CHART.width / 6)}
                x2={CHART.left + index * (CHART.width / 6)}
                y1={CHART.top}
                y2={CHART.top + CHART.height}
              />
            ))}
            {model.yTicks.map((tick) => (
              <line
                key={`h-${tick.value}`}
                x1={CHART.left}
                x2={CHART.left + CHART.width}
                y1={tick.y}
                y2={tick.y}
              />
            ))}
          </g>
          <rect
            className="chartBorder"
            x={CHART.left}
            y={CHART.top}
            width={CHART.width}
            height={CHART.height}
          />
          {metric === 'feesLamports' ? (
            <polygon className="chartArea" points={model.areaPoints} />
          ) : null}
          <polyline className="chartLine" points={model.linePoints} />
          {hoveredPoint ? (
            <g className="chartHoverLayer">
              <line
                className="chartCrosshair"
                x1={hoveredPoint.x}
                x2={hoveredPoint.x}
                y1={CHART.top}
                y2={CHART.top + CHART.height}
              />
              <circle
                className="chartHoverPoint"
                cx={hoveredPoint.x}
                cy={hoveredPoint.y}
                r="1.35"
              />
            </g>
          ) : null}
        </svg>
        <div className="chartYAxis" aria-hidden="true">
          {model.yTicks.map((tick) => (
            <span
              key={tick.value}
              style={{ top: `${viewBoxYToPercent(tick.y)}%` }}
            >
              {formatAxisValue(tick.value, metric)}
            </span>
          ))}
        </div>
        <div className="chartXAxis" aria-hidden="true">
          {model.xTicks.map((tick) => (
            <span
              key={tick.index}
              style={{ left: `${tick.x}%` }}
            >
              {formatBucketLabel(series[tick.index]?.bucket, window)}
            </span>
          ))}
        </div>
      </div>
      {hoveredPoint && hoveredSeriesPoint ? (
        <div
          className="chartTooltip"
          style={{
            left: `${hoveredPoint.tooltipX}%`,
            top: `${hoveredPoint.tooltipY}%`,
          }}
        >
          <strong>{formatBucketTitle(hoveredSeriesPoint.bucket, window)}</strong>
          <span className={metric === 'txCount' ? 'active' : undefined}>
            Txns: {formatInteger(hoveredSeriesPoint.txCount)}
          </span>
          <span className={metric === 'uniqueWallets' ? 'active' : undefined}>
            Wallets: {formatInteger(hoveredSeriesPoint.uniqueWallets)}
          </span>
          <span className={metric === 'feesLamports' ? 'active' : undefined}>
            Fees: {formatLamportsShort(hoveredSeriesPoint.feesLamports)}
          </span>
        </div>
      ) : null}
    </section>
  );
}

export function getChartValue(point: SeriesPoint, metric: ChartMetric): number {
  return metric === 'feesLamports' ? Number(point.feesLamports) : point[metric];
}

export function getNearestSeriesIndex(
  clientX: number,
  rect: Pick<DOMRect, 'left' | 'width'>,
  length: number,
): number | null {
  if (length === 0 || rect.width <= 0) return null;
  const viewBoxX = ((clientX - rect.left) / rect.width) * 100;
  const ratio = Math.min(
    1,
    Math.max(0, (viewBoxX - CHART.left) / CHART.width),
  );
  return Math.min(length - 1, Math.max(0, Math.round(ratio * (length - 1))));
}

export function buildChartModel(series: SeriesPoint[], metric: ChartMetric) {
  const values = series.map((point) => getChartValue(point, metric));
  const maxValue = Math.max(0, ...values);
  const yMax = niceMax(maxValue, metric);
  const points = values.map((value, index) => {
    const x =
      CHART.left +
      (series.length <= 1 ? 0 : (index / (series.length - 1)) * CHART.width);
    const y = CHART.top + CHART.height - (value / yMax) * CHART.height;
    return {
      x,
      y,
      tooltipX: Math.min(76, Math.max(24, x)),
      tooltipY: Math.min(70, Math.max(20, y + 10)),
    };
  });
  const linePoints = points
    .map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`)
    .join(' ');
  const baseline = CHART.top + CHART.height;
  const areaPoints =
    points.length === 0
      ? ''
      : `${CHART.left},${baseline} ${linePoints} ${
          CHART.left + CHART.width
        },${baseline}`;
  return {
    total: values.reduce((sum, value) => sum + value, 0),
    linePoints,
    areaPoints,
    points,
    yTicks: buildYAxisTicks(yMax),
    xTicks: buildXAxisTicks(series.length),
  };
}

export function buildYAxisTicks(maxValue: number) {
  return Array.from({ length: 5 }, (_, index) => {
    const value = (maxValue / 4) * index;
    const y = CHART.top + CHART.height - (value / maxValue) * CHART.height;
    return { value, y };
  }).reverse();
}

export function buildXAxisTicks(length: number) {
  if (length <= 0) return [];
  const tickCount = Math.min(5, length);
  return Array.from({ length: tickCount }, (_, index) => {
    const seriesIndex =
      tickCount === 1 ? 0 : Math.round((index / (tickCount - 1)) * (length - 1));
    const x =
      CHART.left +
      (length <= 1 ? 0 : (seriesIndex / (length - 1)) * CHART.width);
    return { index: seriesIndex, x };
  });
}

function niceMax(value: number, metric: ChartMetric): number {
  if (metric !== 'feesLamports' && value <= 4) return 4;
  if (metric === 'feesLamports' && value < 4_000_000) return 4_000_000;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const niceNormalized =
    normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return niceNormalized * magnitude;
}

export function formatAxisValue(value: number, metric: ChartMetric): string {
  if (metric === 'feesLamports') return formatFeeAxisValue(value);
  return formatInteger(Math.round(value));
}

function formatFeeAxisValue(lamports: number): string {
  if (lamports === 0) return '0 SOL';
  const sol = lamports / 1_000_000_000;
  if (sol < 0.001) {
    return `${trimDecimals(sol, 6)} SOL`;
  }
  if (sol < 1) {
    return `${trimDecimals(sol, 4)} SOL`;
  }
  return `${trimDecimals(sol, 2)} SOL`;
}

function trimDecimals(value: number, digits: number): string {
  return value.toFixed(digits).replace(/\.?0+$/, '');
}

function viewBoxYToPercent(y: number): number {
  return (y / 62) * 100;
}

function formatBucketLabel(bucket: string | undefined, window: DashboardWindow): string {
  if (!bucket) return '';
  const date = new Date(bucket);
  if (window === '24h') {
    return new Intl.DateTimeFormat('en-US', { hour: 'numeric' }).format(date);
  }
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(date);
}

function formatBucketTitle(bucket: string, window: DashboardWindow): string {
  const date = new Date(bucket);
  if (window === '24h') {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  }
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}
