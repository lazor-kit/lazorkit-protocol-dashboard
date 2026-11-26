import { memo, useMemo } from 'react';
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { BinSize, ChartRow } from '../app/selectors';
import { exactLamports, formatInteger, formatLamports, formatSolAxis } from '../lib/format';

export type ValueKind = 'count' | 'lamports';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatBucket(bucket: string, size: BinSize, long = false): string {
  const date = new Date(bucket.length === 10 ? `${bucket}T00:00:00Z` : bucket);
  if (Number.isNaN(date.getTime())) return bucket;
  const day = `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
  if (size === 'hour') {
    const hour = `${date.getUTCHours().toString().padStart(2, '0')}:00`;
    return long ? `${day}, ${hour} UTC` : hour;
  }
  if (size === 'month') return long ? `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}` : MONTHS[date.getUTCMonth()];
  if (size === 'week') return long ? `Week of ${day}, ${date.getUTCFullYear()}` : day;
  return long ? `${day}, ${date.getUTCFullYear()}` : day;
}

/** A "nice" step (1, 2, 2.5, 3, 4, 5 × 10^k) for about `count` intervals; counts never get fractional steps. */
export function niceStep(max: number, count = 4, integer = false): number {
  const raw = max / count;
  if (!(raw > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const ladder = integer && magnitude < 10 ? [1, 2, 3, 4, 5, 10] : [1, 2, 2.5, 3, 4, 5, 10];
  const step = (ladder.find((n) => n * magnitude >= raw - 1e-12) ?? 10) * magnitude;
  return integer ? Math.max(1, Math.round(step)) : step;
}

/** Ticks from 0 to the first step at or above the maximum (at least 4 intervals for small counts). */
export function axisTicks(max: number, kind: ValueKind): number[] {
  const integer = kind === 'count';
  const top = integer ? Math.max(4, max) : max;
  const step = niceStep(top, 4, integer);
  const steps = Math.max(1, Math.ceil(top / step - 1e-9));
  return Array.from({ length: steps + 1 }, (_, index) => Number((index * step).toPrecision(12)));
}

/** Decimals needed to print every tick of a SOL axis distinctly. */
export function axisDecimals(ticks: number[]): number {
  const step = ticks.length > 1 ? ticks[1] - ticks[0] : ticks[0] ?? 1;
  for (let digits = 0; digits <= 9; digits += 1) {
    if (Math.abs(Math.round(step * 10 ** digits) - step * 10 ** digits) < 1e-6) return digits;
  }
  return 9;
}

export function xTicks(rows: readonly ChartRow[], count = 6): string[] {
  if (rows.length <= count) return rows.map((row) => row.bucket);
  return Array.from({ length: count }, (_, index) => rows[Math.round((index / (count - 1)) * (rows.length - 1))].bucket);
}

function formatValue(value: number, kind: ValueKind): string {
  return kind === 'lamports' ? formatLamports(BigInt(Math.round(value))) : formatInteger(Math.round(value));
}

interface TooltipProps {
  active?: boolean;
  payload?: Array<{ payload?: ChartRow }>;
  label?: string | number;
  size: BinSize;
  kind: ValueKind;
  showFailed: boolean;
}

function ChartTooltip({ active, payload, label, size, kind, showFailed }: TooltipProps) {
  const row = payload?.[0]?.payload;
  if (!active || !row || label === undefined) return null;
  return (
    <div className="chartTooltip">
      <strong>{formatBucket(String(label), size, true)}</strong>
      <span title={kind === 'lamports' ? exactLamports(row.total) : undefined}>
        {formatValue(row.total, kind)}
      </span>
      {showFailed ? (
        <span>
          <i className="seriesSwatch seriesSwatch-failed" aria-hidden="true" />Failed: {formatInteger(row.failed)}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Protocol activity by time bucket, with an optional failed-transaction line on the same axis.
 */
export const ChartPanel = memo(function ChartPanel({
  title,
  subtitle,
  rows,
  size,
  kind,
  showFailed = false,
  summary,
}: {
  title: string;
  subtitle: string;
  rows: ChartRow[];
  size: BinSize;
  kind: ValueKind;
  showFailed?: boolean;
  summary: string;
}) {
  const max = useMemo(
    () => Math.max(0, ...rows.map((row) => Math.max(row.total, showFailed ? row.failed : 0))),
    [rows, showFailed],
  );
  const ticks = useMemo(() => axisTicks(kind === 'lamports' ? max / 1e9 : max, kind), [max, kind]);
  const domainTop = ticks[ticks.length - 1];
  const decimals = axisDecimals(ticks);
  const data = useMemo(
    () =>
      rows.map((row) =>
        ({ ...row, plotted: kind === 'lamports' ? row.total / 1e9 : row.total }),
      ),
    [rows, kind],
  );
  const empty = rows.every((row) => row.total === 0);

  return (
    <section className="chartPanel" aria-label={title}>
      <div className="chartHeader">
        <div>
          <h3>{title}</h3>
          <p className="mutedText">{subtitle}</p>
        </div>
        <span className="chartSummary">{summary}</span>
      </div>
      {showFailed ? (
        <ul className="chartLegend" aria-label="Legend">
          <li><i className="seriesSwatch seriesSwatch-v1" aria-hidden="true" />Total</li>
          <li><i className="seriesSwatch seriesSwatch-failed seriesSwatch-line" aria-hidden="true" />Failed</li>
        </ul>
      ) : null}
      <div className="chartCanvas">
        {empty ? <p className="chartEmpty">No activity in this window</p> : null}
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 320, height: 200 }}>
          <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="18%">
            <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
            <XAxis
              dataKey="bucket"
              ticks={xTicks(rows)}
              tickFormatter={(value) => formatBucket(String(value), size)}
              tick={{ fill: 'var(--chart-axis)', fontSize: 12 }}
              tickLine={false}
              axisLine={{ stroke: 'var(--chart-baseline)' }}
              interval="preserveStartEnd"
              minTickGap={12}
            />
            <YAxis
              width={kind === 'lamports' ? Math.max(48, 18 + 7 * (decimals + 2)) : 44}
              domain={[0, domainTop]}
              ticks={ticks}
              allowDecimals={kind === 'lamports'}
              tickFormatter={(value) => (kind === 'lamports' ? formatSolAxis(Number(value), decimals) : formatInteger(Math.round(Number(value))))}
              tick={{ fill: 'var(--chart-axis)', fontSize: 12 }}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip
              cursor={{ fill: 'var(--chart-cursor)' }}
              isAnimationActive={false}
              content={<ChartTooltip size={size} kind={kind} showFailed={showFailed} />}
            />
            <Bar
              dataKey="plotted"
              name={title}
              fill="var(--series-v1)"
              stroke="var(--surface)"
              strokeWidth={1}
              maxBarSize={24}
              radius={[4, 4, 0, 0]}
              isAnimationActive={false}
            />
            {showFailed ? (
              <Line
                dataKey="failed"
                name="Failed"
                type="linear"
                stroke="var(--status-critical)"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, fill: 'var(--status-critical)', stroke: 'var(--surface)', strokeWidth: 2 }}
                isAnimationActive={false}
              />
            ) : null}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <details className="chartTable">
        <summary>Data table</summary>
        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th scope="col">{size === 'hour' ? 'Hour (UTC)' : size === 'day' ? 'Day (UTC)' : size === 'week' ? 'Week of' : 'Month'}</th>
                <th scope="col">Total</th>
                {showFailed ? <th scope="col">Failed</th> : null}
              </tr>
            </thead>
            <tbody>
              {[...rows].reverse().map((row) => (
                <tr key={row.bucket}>
                  <td>{formatBucket(row.bucket, size, true)}</td>
                  <td className="num">{formatValue(row.total, kind)}</td>
                  {showFailed ? <td className="num">{formatInteger(row.failed)}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
});
