import { ChevronDown, Database } from 'lucide-react';
import type { DashboardPayload, RunRow } from '../types/dashboard';
import { FRESHNESS_LABELS } from '../app/selectors';
import { formatAge, formatDuration, formatInteger, formatUtc } from '../lib/format';
import { DataNotes } from './DataNotes';
import { StatRow, VersionTag } from './ui';

const WORKFLOW_LABELS: Record<string, string> = {
  active: 'active',
  disabled_inactivity: 'disabled by GitHub (inactivity)',
  disabled_manually: 'disabled',
  unknown: 'unknown (no heartbeat from the daily Vercel cron yet)',
};

// GITHUB_EVENT_NAME recorded by the worker in its heartbeat (README "Freshness and keep-alive")
const TRIGGER_LABELS: Record<string, string> = {
  schedule: 'GitHub schedule',
  repository_dispatch: 'external cron (repository_dispatch)',
  workflow_dispatch: 'manual run (workflow_dispatch)',
  push: 'push to main',
  local: 'local run',
};

export function triggerLabel(trigger: string | null | undefined): string {
  if (!trigger) return '–';
  return TRIGGER_LABELS[trigger] ?? trigger;
}

function checkValue(value: string | null): string {
  if (value === null) return '–';
  return /^-?\d+$/.test(value) ? formatInteger(value) : value;
}

export function runTimings(runs: RunRow[]): Array<RunRow & { durationMs: number | null; gapMs: number | null }> {
  const sorted = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return sorted.map((run, index) => {
    const older = sorted[index + 1];
    const durationMs = run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : null;
    const gapMs = older ? Date.parse(run.startedAt) - Date.parse(older.startedAt) : null;
    return { ...run, durationMs, gapMs };
  });
}

/** Section 10: sync state per program, invariant checks, recent runs, heartbeats, data notes. Collapsed. */
export function DeveloperDetails({ payload, now, open }: { payload: DashboardPayload; now: number; open: boolean }) {
  const programs = [...payload.programs].sort((a, b) => a.version - b.version);
  const checks = programs.flatMap((program) => program.checks.map((check) => ({ program, check })));
  const runs = runTimings(payload.runs);
  const { freshness } = payload;
  return (
    <details className="technicalDetails" id="developer-details" open={open}>
      <summary>
        <div className="technicalSummaryMain">
          <Database size={18} aria-hidden="true" />
          <span>
            Developer details
            <small>Indexer sync, invariant checks, runs, heartbeats and metric definitions</small>
          </span>
        </div>
        <div className="technicalSummaryAction">
          <span className="showLabel">Show details</span>
          <span className="hideLabel">Hide details</span>
          <ChevronDown size={18} aria-hidden="true" />
        </div>
      </summary>

      <section className="panel" aria-labelledby="sync-title">
        <h3 id="sync-title">Sync per program</h3>
        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Program</th>
                <th scope="col">Gen / parser</th>
                <th scope="col">Backfill</th>
                <th scope="col">Complete through</th>
                <th scope="col">Discovered at</th>
                <th scope="col" className="num">Ingested</th>
                <th scope="col" className="num">Pending</th>
                <th scope="col" className="num">Gaps</th>
                <th scope="col">Last run</th>
                <th scope="col" className="num">Failures in a row</th>
                <th scope="col">Last error</th>
              </tr>
            </thead>
            <tbody>
              {programs.map((program) => (
                <tr key={program.programKey}>
                  <td>
                    <VersionTag version={program.version} /> {program.label}
                  </td>
                  <td>
                    {program.sync.activeGen} / {program.sync.parserVersion}
                    {program.sync.building ? (
                      <span className="cellSub">
                        rebuilding gen {program.sync.building.gen}: {formatInteger(program.sync.building.ingested)} ingested,{' '}
                        {formatInteger(program.sync.building.pending)} pending
                      </span>
                    ) : null}
                  </td>
                  <td>
                    {program.deployment.status !== 'live'
                      ? 'not deployed'
                      : program.sync.backfillComplete
                        ? `complete (${program.sync.historyProof === 'deploy_tx' ? 'from the deploy tx' : program.sync.historyProof === 'archival_end' ? 'archival end' : 'no proof'})`
                        : 'in progress'}
                  </td>
                  <td>{formatUtc(program.sync.completeThrough, now, { alwaysDate: true })}</td>
                  <td>{formatUtc(program.sync.discoveredAt, now, { alwaysDate: true })}</td>
                  <td className="num">{formatInteger(program.sync.ingested)}</td>
                  <td className="num">{formatInteger(program.sync.pending)}</td>
                  <td className="num">{formatInteger(program.sync.gapsOpen)}</td>
                  <td>
                    {program.sync.lastRunStatus}
                    <span className="cellSub">{program.sync.lastRunFinishedAt ? formatAge(program.sync.lastRunFinishedAt, now) : '–'}</span>
                  </td>
                  <td className="num">{formatInteger(program.sync.consecutiveFailures)}</td>
                  <td className="errorCell" title={program.sync.lastError ?? undefined}>
                    {program.sync.lastError ?? '–'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel" aria-labelledby="checks-title">
        <h3 id="checks-title">Invariant checks</h3>
        <p className="panelNote">
          History recomputed through the state snapshot slot must equal the on-chain accounts. Informational checks are
          shown but never raise a warning (devnet v1 ran older binaries).
        </p>
        {checks.length === 0 ? (
          <p className="emptyLine">No checks yet.</p>
        ) : (
          <div className="tableWrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Program</th>
                  <th scope="col">Check</th>
                  <th scope="col" className="num">Expected</th>
                  <th scope="col" className="num">Actual</th>
                  <th scope="col">Result</th>
                </tr>
              </thead>
              <tbody>
                {checks.map(({ program, check }) => (
                  <tr key={`${program.programKey}-${check.id}`}>
                    <td>
                      <VersionTag version={program.version} /> {program.label}
                    </td>
                    <td>
                      <strong>{check.id}</strong> {check.label}
                      {check.note ? <span className="cellSub">{check.note}</span> : null}
                    </td>
                    <td className="num">{checkValue(check.expected)}</td>
                    <td className="num">{checkValue(check.actual)}</td>
                    <td>
                      {check.mode === 'pending' || check.ok === null ? (
                        <span className="statusBadge neutral">pending</span>
                      ) : check.ok ? (
                        <span className="statusBadge success">✓ ok{check.mode === 'informational' ? ' · info' : ''}</span>
                      ) : (
                        <span className={`statusBadge ${check.mode === 'enforce' ? 'failed' : 'neutral'}`}>
                          ✕ mismatch{check.mode === 'informational' ? ' · info' : ''}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel" aria-labelledby="runs-title">
        <h3 id="runs-title">Indexer runs and heartbeats</h3>
        <div className="heartbeatGrid">
          <dl className="statList compact">
            <StatRow label="Data status" value={FRESHNESS_LABELS[freshness.state]} />
            <StatRow label="Last indexer run" value={formatUtc(freshness.lastWorkerRunAt, now, { alwaysDate: true, seconds: true })} hint={freshness.lastWorkerRunAt ? formatAge(freshness.lastWorkerRunAt, now) : null} />
            <StatRow label="Last run started by" value={triggerLabel(freshness.lastWorkerTrigger)} />
            <StatRow label="GitHub workflow" value={WORKFLOW_LABELS[freshness.workflow.state] ?? freshness.workflow.state} />
            <StatRow label="Workflow checked" value={formatUtc(freshness.workflow.checkedAt, now, { alwaysDate: true })} />
            <StatRow
              label="Last scheduled run"
              value={formatUtc(freshness.workflow.lastScheduledRunAt, now, { alwaysDate: true })}
              hint={freshness.workflow.lastConclusion}
            />
            <StatRow label="Database schema" value={payload.dbSchemaVersion === null ? '–' : `version ${payload.dbSchemaVersion}`} />
            <StatRow label="Response generated" value={formatUtc(payload.generatedAt, now, { alwaysDate: true, seconds: true })} />
          </dl>
          {freshness.reasons.length > 0 ? (
            <ul className="reasonList">
              {freshness.reasons.map((reason) => (
                <li key={`${reason.code}-${reason.programKey ?? ''}`}>
                  <code>{reason.code}</code> {reason.detail}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        {runs.length === 0 ? (
          <p className="emptyLine">No runs recorded yet.</p>
        ) : (
          <div className="tableWrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Run</th>
                  <th scope="col">Started</th>
                  <th scope="col" className="num">Duration</th>
                  <th scope="col" className="num">Since previous run</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.runId}>
                    <td className="mono">{run.runId}</td>
                    <td>{formatUtc(run.startedAt, now, { alwaysDate: true, seconds: true })}</td>
                    <td className="num">{formatDuration(run.durationMs)}</td>
                    <td className="num">{formatDuration(run.gapMs)}</td>
                    <td>{run.status ?? 'running'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <DataNotes />
    </details>
  );
}
