import { useMemo } from 'react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { DashboardPayload, MigrationView } from '../types/dashboard';
import { exactLamports, formatInteger, formatLamports, shortHash } from '../lib/format';
import { formatBucket } from './ChartPanel';
import { Pill, SectionHeader, StatRow } from './ui';

/** Migrations per day with the gaps filled, plus the running total (spec §11.2 item 8). */
export function migrationRows(series: MigrationView['series']): Array<{ day: string; migrations: number; cumulative: number }> {
  if (series.length === 0) return [];
  const byDay = new Map(series.map((point) => [point.day.slice(0, 10), point.migrations]));
  const sorted = [...byDay.keys()].sort();
  const rows: Array<{ day: string; migrations: number; cumulative: number }> = [];
  let cumulative = 0;
  for (let day = new Date(`${sorted[0]}T00:00:00Z`); day <= new Date(`${sorted[sorted.length - 1]}T00:00:00Z`); day.setUTCDate(day.getUTCDate() + 1)) {
    const key = day.toISOString().slice(0, 10);
    const migrations = byDay.get(key) ?? 0;
    cumulative += migrations;
    rows.push({ day: key, migrations, cumulative });
  }
  return rows;
}

function MiniChart({ rows, kind }: { rows: ReturnType<typeof migrationRows>; kind: 'daily' | 'cumulative' }) {
  const common = (
    <>
      <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
      <XAxis
        dataKey="day"
        tickFormatter={(value) => formatBucket(String(value), 'day')}
        tick={{ fill: 'var(--chart-axis)', fontSize: 12 }}
        tickLine={false}
        axisLine={{ stroke: 'var(--chart-baseline)' }}
        minTickGap={16}
      />
      <YAxis width={40} allowDecimals={false} tick={{ fill: 'var(--chart-axis)', fontSize: 12 }} tickLine={false} axisLine={false} />
      <Tooltip
        isAnimationActive={false}
        cursor={{ fill: 'var(--chart-cursor)' }}
        content={({ active, payload, label }) =>
          active && payload?.length ? (
            <div className="chartTooltip">
              <strong>{formatBucket(String(label), 'day', true)}</strong>
              <span>Migrations: {formatInteger(Number(payload[0]?.payload?.migrations ?? 0))}</span>
              <span>Cumulative: {formatInteger(Number(payload[0]?.payload?.cumulative ?? 0))}</span>
            </div>
          ) : null
        }
      />
    </>
  );
  return (
    <div className="miniChart">
      <h4>{kind === 'daily' ? 'Migrations per day' : 'Migrated wallets, cumulative'}</h4>
      <div className="miniChartCanvas">
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 320, height: 200 }}>
          {kind === 'daily' ? (
            <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              {common}
              <Bar dataKey="migrations" fill="var(--series-v2)" maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false} />
            </BarChart>
          ) : (
            <LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              {common}
              <Line dataKey="cumulative" stroke="var(--series-v2)" strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/** Section 8: the v1 → v2 migration (Phase B). Before the sunset build ships it explains what it will track. */
export function MigrationPanel({ payload }: { payload: DashboardPayload }) {
  const migration = payload.migration;
  const rows = useMemo(() => migrationRows(migration?.series ?? []), [migration]);
  if (!migration) return null;
  const v1 = payload.programs.find((program) => program.programKey === migration.v1ProgramKey);
  const v2 = payload.programs.find((program) => program.programKey === migration.v2ProgramKey);
  const v2Live = v2?.deployment.status === 'live';
  const v1Funded = v1?.state?.vaults.funded ?? null;

  const leftovers = (
    <div className="detailBlock">
      <h4>Left on v1</h4>
      <dl className="statList compact">
        <StatRow label="Wallets still on v1" value={formatInteger(migration.v1WalletsRemaining)} hint={v1Funded !== null ? `${formatInteger(v1Funded)} hold SOL` : null} />
        <StatRow
          label="SOL in their vaults"
          value={formatLamports(migration.v1RemainingVaultLamports)}
          title={exactLamports(migration.v1RemainingVaultLamports)}
        />
        <StatRow label="Open sessions / deferred" value={`${formatInteger(migration.leftovers.v1Sessions)} / ${formatInteger(migration.leftovers.v1Deferred)}`} />
      </dl>
    </div>
  );
  const cleanup = (
    <div className="detailBlock">
      <h4>Cleanup (all history)</h4>
      <dl className="statList compact">
        <StatRow label="ReclaimDeferred" value={formatInteger(migration.cleanup.reclaimDeferred)} />
        <StatRow label="CloseExpiredSession" value={formatInteger(migration.cleanup.closeExpiredSession)} />
        <StatRow label="Rent returned" value={formatLamports(migration.cleanup.lamports)} title={exactLamports(migration.cleanup.lamports)} />
      </dl>
    </div>
  );

  return (
    <section className="panel" aria-labelledby="migration-title">
      <SectionHeader
        id="migration-title"
        eyebrow="Migration"
        title="v1 → v2"
        aside={<Pill tone={migration.status === 'active' ? 'info' : 'neutral'}>{migration.status === 'active' ? 'In progress' : 'Not started'}</Pill>}
      />
      {migration.status === 'not_started' ? (
        <>
          <p className="panelNote">
            Migration has not started: v1 still runs the full v1 build
            {v1?.deployment.sha256 ? (
              <>
                {' '}
                (<code title={v1.deployment.sha256}>{shortHash(v1.deployment.sha256)}</code>)
              </>
            ) : null}
            . Once the sunset build is deployed, this panel tracks MigrateWallet: wallets and SOL moved to v2, what is left on v1, and
            clients still calling retired v1 instructions.
          </p>
          <div className="detailColumns">
            {leftovers}
            <div className="detailBlock">
              <h4>v2 wallets</h4>
              <dl className="statList compact">
                <StatRow label="Created on v2" value={v2Live ? formatInteger(migration.v2WalletsNew + migration.v2WalletsFromMigration) : 'v2 not deployed'} />
                <StatRow label="Migrated from v1" value={formatInteger(migration.v2WalletsFromMigration)} />
              </dl>
            </div>
            {cleanup}
          </div>
        </>
      ) : (
        <>
          <div className="migrationHeadline">
            <div>
              <span className="kpiLabel">Migrated</span>
              <strong className="kpiValue">{migration.percentMigrated === null ? '–' : `${migration.percentMigrated.toFixed(1).replace(/\.0$/, '')}%`}</strong>
              <span className="kpiSub">
                {formatInteger(migration.totals.migrations)} of {formatInteger(migration.totals.migrations + (migration.v1WalletsRemaining ?? 0))} v1 wallets
              </span>
            </div>
            <div>
              <span className="kpiLabel">SOL moved</span>
              <strong className="kpiValue" title={exactLamports(migration.totals.migratedLamports)}>
                {formatLamports(migration.totals.migratedLamports)}
              </strong>
              <span className="kpiSub">{formatInteger(migration.totals.tokenAccounts)} token accounts moved</span>
            </div>
            <div>
              <span className="kpiLabel">v2 wallets</span>
              <strong className="kpiValue">{formatInteger(migration.v2WalletsFromMigration)}</strong>
              <span className="kpiSub">migrated · {formatInteger(migration.v2WalletsNew)} new</span>
            </div>
            <div>
              <span className="kpiLabel">Retired v1 calls</span>
              <strong className="kpiValue">{formatInteger(migration.retiredCalls)}</strong>
              <span className="kpiSub">clients still calling retired instructions</span>
            </div>
          </div>
          {rows.length > 0 ? (
            <div className="miniChartGrid">
              <MiniChart rows={rows} kind="daily" />
              <MiniChart rows={rows} kind="cumulative" />
            </div>
          ) : (
            <p className="emptyLine">No MigrateWallet transaction yet.</p>
          )}
          <div className="detailColumns">
            {leftovers}
            {cleanup}
          </div>
        </>
      )}
    </section>
  );
}
