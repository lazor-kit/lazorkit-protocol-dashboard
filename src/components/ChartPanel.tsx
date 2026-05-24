import { memo, useMemo } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { DashboardWindow, SeriesPoint } from '../solana/dashboardTypes';
import { formatInteger, formatLamportsShort } from '../solana/format';

export type ChartMetric = 'txCount' | 'uniqueWallets' | 'feesLamports';

interface ChartDatum {
  bucket: string;
  txCount: number;
  uniqueWallets: number;
  feesLamports: number;
  feeEventCount: number;
}

const METRIC_LABELS: Record<ChartMetric, string> = {
  txCount: 'Txns',
  uniqueWallets: 'Wallets',
  feesLamports: 'Fees',
};

export const ChartPanel = memo(function ChartPanel({
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
  const data = useMemo(() => toChartData(series), [series]);
  const total = useMemo(
    () => data.reduce((sum, point) => sum + point[metric], 0),
    [data, metric],
  );
  const yDomain = useMemo(() => buildYAxisDomain(data, metric), [data, metric]);
  const xTicks = useMemo(() => buildXAxisTicks(data), [data]);

  const chartProps = {
    data,
    margin: { top: 16, right: 18, bottom: 8, left: 0 },
  };

  const commonChildren = (
    <>
      <CartesianGrid stroke="#273451" strokeDasharray="3 3" />
      <XAxis
        dataKey="bucket"
        ticks={xTicks}
        tickFormatter={(value) => formatXAxisTick(String(value), window)}
        tick={{ fill: '#7f8ba4', fontSize: 12, fontWeight: 700 }}
        tickLine={false}
        axisLine={{ stroke: '#35466e' }}
        minTickGap={18}
        interval="preserveStartEnd"
      />
      <YAxis
        width={metric === 'feesLamports' ? 76 : 64}
        domain={yDomain}
        tickCount={5}
        allowDecimals={metric === 'feesLamports'}
        tickFormatter={(value) => formatYAxisTick(Number(value), metric)}
        tick={{ fill: '#7f8ba4', fontSize: 12, fontWeight: 700 }}
        tickLine={false}
        axisLine={false}
      />
      <Tooltip
        cursor={{ stroke: '#9b86ff', strokeWidth: 1, strokeDasharray: '3 3' }}
        content={<ChartTooltip metric={metric} window={window} />}
        isAnimationActive={false}
      />
    </>
  );

  return (
    <section className={`chartPanel chartPanel-${metric}`} aria-label={title}>
      <div className="chartHeader">
        <div>
          <h2>{title}</h2>
        </div>
        <span className="mutedText">
          {metric === 'feesLamports'
            ? formatLamportsShort(BigInt(Math.round(total)))
            : formatInteger(total)}
        </span>
      </div>
      <div className="chartCanvas">
        <ResponsiveContainer width="100%" height="100%">
          {metric === 'feesLamports' ? (
            <AreaChart {...chartProps}>
              {commonChildren}
              <Area
                type="monotone"
                dataKey={metric}
                stroke="#7557ff"
                strokeWidth={2.25}
                fill="#7557ff"
                fillOpacity={0.16}
                dot={false}
                activeDot={{ r: 4, stroke: '#eef3ff', strokeWidth: 1 }}
                isAnimationActive={false}
              />
            </AreaChart>
          ) : (
            <LineChart {...chartProps}>
              {commonChildren}
              <Line
                type="monotone"
                dataKey={metric}
                stroke={metric === 'uniqueWallets' ? '#9b86ff' : '#7557ff'}
                strokeWidth={2.25}
                dot={false}
                activeDot={{ r: 4, stroke: '#eef3ff', strokeWidth: 1 }}
                isAnimationActive={false}
              />
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
    </section>
  );
});

export function toChartData(series: SeriesPoint[]): ChartDatum[] {
  return series.map((point) => ({
    bucket: point.bucket,
    txCount: point.txCount,
    uniqueWallets: point.uniqueWallets,
    feesLamports: Number(point.feesLamports),
    feeEventCount: point.feeEventCount,
  }));
}

export function buildYAxisDomain(
  data: readonly ChartDatum[],
  metric: ChartMetric,
): [number, number] {
  const maxValue = Math.max(0, ...data.map((point) => point[metric]));
  if (metric === 'feesLamports') {
    return [0, niceMax(maxValue)];
  }
  return [0, Math.max(4, niceMax(maxValue))];
}

export function buildXAxisTicks(data: readonly ChartDatum[]): string[] {
  if (data.length <= 5) return data.map((point) => point.bucket);
  return Array.from({ length: 5 }, (_, index) => {
    const dataIndex = Math.round((index / 4) * (data.length - 1));
    return data[dataIndex].bucket;
  });
}

export function formatYAxisTick(value: number, metric: ChartMetric): string {
  if (metric === 'feesLamports') return formatFeeAxisValue(value);
  return formatInteger(Math.round(value));
}

export function formatXAxisTick(bucket: string, window: DashboardWindow): string {
  const date = new Date(bucket);
  if (window === '24h') {
    return new Intl.DateTimeFormat('en-US', { hour: 'numeric' }).format(date);
  }
  if (window === 'all') {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      year: '2-digit',
    }).format(date);
  }
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(date);
}

export function formatTooltipLabel(
  bucket: string,
  window: DashboardWindow,
): string {
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

interface ChartTooltipProps {
  active?: boolean;
  payload?: Array<{ payload?: ChartDatum }>;
  label?: string | number;
  metric: ChartMetric;
  window: DashboardWindow;
}

function ChartTooltip({
  active,
  payload,
  label,
  metric,
  window,
}: ChartTooltipProps) {
  if (!active || !payload?.length || label === undefined) return null;

  const datum = payload[0]?.payload;
  if (!datum) return null;

  return (
    <div className="chartTooltip">
      <strong>{formatTooltipLabel(String(label), window)}</strong>
      <span className={metric === 'txCount' ? 'active' : undefined}>
        {METRIC_LABELS.txCount}: {formatInteger(datum.txCount)}
      </span>
      <span className={metric === 'uniqueWallets' ? 'active' : undefined}>
        {METRIC_LABELS.uniqueWallets}: {formatInteger(datum.uniqueWallets)}
      </span>
      <span className={metric === 'feesLamports' ? 'active' : undefined}>
        {METRIC_LABELS.feesLamports}: {formatSolFromLamports(datum.feesLamports)}
      </span>
      {metric === 'feesLamports' ? (
        <>
          <span>Paid events: {formatInteger(datum.feeEventCount)}</span>
          <span>
            Avg fee/event:{' '}
            {formatSolFromLamports(
              datum.feeEventCount === 0
                ? 0
                : datum.feesLamports / datum.feeEventCount,
            )}
          </span>
        </>
      ) : null}
    </div>
  );
}

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const niceNormalized = normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return niceNormalized * magnitude;
}

function formatFeeAxisValue(lamports: number): string {
  if (lamports === 0) return '0';
  return formatSolNumber(lamports / 1_000_000_000);
}

function formatSolFromLamports(lamports: number): string {
  if (lamports === 0) return '0 SOL';
  return `${formatSolNumber(lamports / 1_000_000_000)} SOL`;
}

function formatSolNumber(sol: number): string {
  if (sol < 0.000001) return trimDecimals(sol, 9);
  if (sol < 0.01) return trimDecimals(sol, 6);
  if (sol < 1) return trimDecimals(sol, 4);
  return trimDecimals(sol, 2);
}

function trimDecimals(value: number, digits: number): string {
  return value.toFixed(digits).replace(/\.?0+$/, '');
}
