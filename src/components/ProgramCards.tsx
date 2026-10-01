import type { DashboardPayload, ProgramView, ScopeKey } from '../types/dashboard';
import { backfillPercent, expectedNextBinary, programBadge, visiblePrograms, windowLabel } from '../app/selectors';
import type { VersionFilter } from '../app/urlState';
import { formatAge, formatBytes, formatInteger, formatUtc, shortHash } from '../lib/format';
import { AddressLink, Pill, StatRow, VersionTag } from './ui';

const RUN_LABELS: Record<ProgramView['sync']['lastRunStatus'], string> = {
  idle: 'not run yet',
  ok: 'ok',
  lagging: 'ok, backlog left',
  failed: 'failed',
  not_deployed: 'checked, not deployed',
};

function syncText(program: ProgramView, now: number): string {
  const { sync } = program;
  if (!sync.backfillComplete) {
    const percent = backfillPercent(program);
    return `Building history: ${percent === null ? '–' : `${Math.floor(percent)} %`} (${formatInteger(sync.ingested)} of ${formatInteger(sync.ingested + sync.pending)})`;
  }
  const through = sync.completeThrough ? `Complete through ${formatUtc(sync.completeThrough, now)}` : 'Complete';
  return sync.pending > 0 ? `${through} · ${formatInteger(sync.pending)} pending` : through;
}

export function ProgramCard({ program, payload, now }: { program: ProgramView; payload: DashboardPayload; now: number }) {
  const badge = programBadge(program, now);
  const kpis = payload.kpis[String(program.programKey) as ScopeKey]?.current;
  const { deployment, sync } = program;

  if (deployment.status === 'not_deployed') {
    const expected = expectedNextBinary(program, payload.binaries);
    return (
      <article className="programCard programCard-pending" aria-label={`${program.label}: not deployed yet`}>
        <header className="programCardHeader">
          <div>
            <p className="eyebrow">Protocol v{program.version}</p>
            <h3>
              <VersionTag version={program.version} /> {program.label}
            </h3>
          </div>
          <Pill tone={badge.tone}>{badge.label}</Pill>
        </header>
        <p className="programCardNote">
          <code>{program.programId.slice(0, 9)}…</code> has no account on {program.cluster}. It will be picked up
          automatically on its first deploy
          {expected ? (
            <>
              {' '}
              (expected build <code title={expected.binary.sha256}>{shortHash(expected.binary.sha256)}</code>,{' '}
              {formatBytes(expected.binary.elfSize)})
            </>
          ) : null}
          .
        </p>
        <dl className="statList">
          <StatRow label="Program id" value={<AddressLink address={program.programId} cluster={program.cluster} label="program id" copy chars={6} />} />
          <StatRow label="Last check" value={sync.lastRunFinishedAt ? formatAge(sync.lastRunFinishedAt, now) : 'not checked yet'} />
        </dl>
      </article>
    );
  }

  return (
    <article className="programCard" aria-label={`${program.label}: ${badge.label}`}>
      <header className="programCardHeader">
        <div>
          <p className="eyebrow">Protocol v{program.version}</p>
          <h3>
            <VersionTag version={program.version} /> {program.label}
          </h3>
        </div>
        <Pill tone={badge.tone}>{badge.label}</Pill>
      </header>
      <dl className="statList">
        <StatRow label="Program id" value={<AddressLink address={program.programId} cluster={program.cluster} label="program id" copy chars={6} />} />
        <StatRow
          label="Build"
          value={deployment.binaryLabel ?? 'unrecognised'}
          hint={deployment.sha256 ? <code title={deployment.sha256}>{shortHash(deployment.sha256)}</code> : null}
        />
        <StatRow label="Deployed" value={deployment.deployedAt ? formatUtc(deployment.deployedAt, now, { alwaysDate: true }) : '–'} />
        <StatRow label="Sync" value={syncText(program, now)} hint={sync.gapsOpen > 0 ? `${sync.gapsOpen} open gaps` : null} />
        <StatRow
          label="Last run"
          value={
            <span className={sync.lastRunStatus === 'failed' ? 'warningText' : undefined}>
              {RUN_LABELS[sync.lastRunStatus]}
              {sync.lastRunFinishedAt ? ` · ${formatAge(sync.lastRunFinishedAt, now)}` : ''}
            </span>
          }
          hint={sync.consecutiveFailures > 0 ? `${sync.consecutiveFailures} failed in a row` : null}
          title={sync.lastError ?? undefined}
        />
        <StatRow
          label="Last activity"
          value={sync.lastActivityAt ? formatAge(sync.lastActivityAt, now) : 'none yet'}
          title={sync.lastActivityAt ? formatUtc(sync.lastActivityAt, now, { alwaysDate: true }) : undefined}
        />
        {kpis ? (
          <StatRow
            label={`Transactions, ${windowLabel(payload.window)}`}
            value={formatInteger(kpis.txs)}
            hint={kpis.txsFailed > 0 ? `${formatInteger(kpis.txsFailed)} failed` : null}
          />
        ) : null}
      </dl>
      {sync.lastError ? <p className="programCardError">Last error: {sync.lastError}</p> : null}
    </article>
  );
}

/** Section 4: one card per program of the cluster (following the version filter). */
export function ProgramCards({ payload, version, now }: { payload: DashboardPayload; version: VersionFilter; now: number }) {
  const programs = visiblePrograms(payload, version);
  if (programs.length === 0) return null;
  return (
    <section className="programGrid" aria-label="Programs">
      {programs.map((program) => (
        <ProgramCard key={program.programKey} program={program} payload={payload} now={now} />
      ))}
    </section>
  );
}
