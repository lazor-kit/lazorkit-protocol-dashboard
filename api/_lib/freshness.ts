// Freshness state machine (spec §10.3). The first matching row wins:
//   setup_required  PGRST202 on lk_dashboard, or lk_schema_version() below the expected version   (caller)
//   unavailable     network error, timeout or 5xx from Supabase (a paused project, ...)              (caller)
//   stale           worker heartbeat older than 24 h, or the vercel-cron heartbeat (<= 48 h old) says the
//                   GitHub workflow is disabled
//   delayed         worker heartbeat 8-24 h old, or a live program with >= 2 consecutive failures
//   catching_up     no worker heartbeat yet, or a live program with an unfinished backfill or pending signatures
//   live            otherwise
// 8 h is above the largest observed gap between scheduled GitHub runs (6.05 h); 24 h is about 4x that.

import type { Freshness, FreshnessReason, FreshnessState, Heartbeats, WorkflowState } from '../../src/types/dashboard.js';

export const DELAYED_AFTER_MS = 8 * 3600_000;
export const STALE_AFTER_MS = 24 * 3600_000;
export const CRON_HEARTBEAT_MAX_AGE_MS = 48 * 3600_000;

export interface FreshnessProgram {
  programKey: number;
  label: string;
  live: boolean;
  backfillComplete: boolean;
  pending: number;
  ingested: number;
  consecutiveFailures: number;
  completeThrough: string | null;
}

function ageMs(now: Date, at: string | null | undefined): number | null {
  if (!at) return null;
  const time = Date.parse(at);
  return Number.isFinite(time) ? now.getTime() - time : null;
}

function workflowState(value: unknown): WorkflowState {
  if (value === 'active' || value === 'disabled_inactivity' || value === 'disabled_manually') return value;
  if (typeof value === 'string' && value.startsWith('disabled')) return 'disabled_manually';
  return 'unknown';
}

function hours(ms: number): string {
  return `${(ms / 3600_000).toFixed(1)} h`;
}

export function computeFreshness(input: {
  now: Date;
  programs: FreshnessProgram[];
  heartbeats: Heartbeats | null | undefined;
}): Freshness {
  const { now, programs } = input;
  const heartbeats = input.heartbeats ?? {};
  const worker = heartbeats.worker ?? null;
  const cron = heartbeats['vercel-cron'] ?? null;
  const workerAge = ageMs(now, worker?.at);
  const cronAge = ageMs(now, cron?.at);
  const cronDetail = (cron?.detail ?? {}) as Record<string, unknown>;
  const workflow = {
    state: cron ? workflowState(cronDetail.workflow_state) : ('unknown' as WorkflowState),
    checkedAt: cron?.at ?? null,
    lastScheduledRunAt: typeof cronDetail.last_scheduled_run_at === 'string' ? cronDetail.last_scheduled_run_at : null,
    lastConclusion: typeof cronDetail.last_conclusion === 'string' ? cronDetail.last_conclusion : null,
  };
  const live = programs.filter((program) => program.live);
  const reasons: FreshnessReason[] = [];

  const workflowDisabled =
    cronAge !== null && cronAge <= CRON_HEARTBEAT_MAX_AGE_MS && workflow.state.startsWith('disabled');
  if (workflowDisabled) {
    reasons.push({
      code: 'workflow_disabled',
      detail:
        workflow.state === 'disabled_inactivity'
          ? 'GitHub disabled the scheduled indexer workflow (60 days without repository activity)'
          : 'The scheduled indexer workflow is disabled',
    });
  }
  if (workerAge === null) {
    reasons.push({ code: 'never_run', detail: 'The indexer has not reported a run yet' });
  } else if (workerAge > DELAYED_AFTER_MS) {
    reasons.push({ code: 'worker_old', detail: `The last indexer run finished ${hours(workerAge)} ago` });
  }
  for (const program of live) {
    if (program.consecutiveFailures >= 2) {
      reasons.push({
        code: 'program_failing',
        programKey: program.programKey,
        detail: `${program.label}: ${program.consecutiveFailures} failed runs in a row`,
      });
    }
    if (!program.backfillComplete) {
      reasons.push({
        code: 'backfill',
        programKey: program.programKey,
        detail: `${program.label}: building history (${program.ingested} of ${program.ingested + program.pending} transactions)`,
      });
    } else if (program.pending > 0) {
      reasons.push({
        code: 'backlog',
        programKey: program.programKey,
        detail: `${program.label}: ${program.pending} new transactions pending`,
      });
    }
  }

  let state: FreshnessState;
  if ((workerAge !== null && workerAge > STALE_AFTER_MS) || workflowDisabled) state = 'stale';
  else if ((workerAge !== null && workerAge > DELAYED_AFTER_MS) || live.some((p) => p.consecutiveFailures >= 2)) state = 'delayed';
  else if (workerAge === null || live.some((p) => !p.backfillComplete || p.pending > 0)) state = 'catching_up';
  else state = 'live';

  // complete through = the earliest point every live program is complete through (null if one never synced)
  const throughTimes = live.map((p) => p.completeThrough);
  const completeThrough =
    throughTimes.length === 0 || throughTimes.some((t) => !t)
      ? null
      : (throughTimes as string[]).reduce((min, t) => (Date.parse(t) < Date.parse(min) ? t : min));

  return {
    state,
    completeThrough,
    lastWorkerRunAt: worker?.at ?? null,
    workflow,
    reasons,
    catchUp: live
      .filter((p) => !p.backfillComplete || p.pending > 0)
      .map((p) => ({
        programKey: p.programKey,
        pending: p.pending,
        ingested: p.ingested,
        percent: p.ingested + p.pending > 0 ? Math.floor((1000 * p.ingested) / (p.ingested + p.pending)) / 10 : null,
      })),
  };
}

export function fixedFreshness(state: 'setup_required' | 'unavailable', detail: string): Freshness {
  return {
    state,
    completeThrough: null,
    lastWorkerRunAt: null,
    workflow: { state: 'unknown', checkedAt: null, lastScheduledRunAt: null, lastConclusion: null },
    reasons: [{ code: state === 'setup_required' ? 'schema_missing' : 'db_unavailable', detail }],
    catchUp: [],
  };
}
