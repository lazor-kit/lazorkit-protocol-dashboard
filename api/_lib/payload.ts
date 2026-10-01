// Builds the public payloads from the lk_* RPC results (spec §10.2-§10.4).

import {
  DASHBOARD_API_VERSION,
  EXPECTED_DB_SCHEMA_VERSION,
  type Cluster,
  type DashboardPayload,
  type DashboardWindow,
  type HealthPayload,
  type HealthProgram,
  type Heartbeats,
  type ProgramView,
} from '../../src/types/dashboard.js';
import { computeFreshness, fixedFreshness, type FreshnessProgram } from './freshness.js';

export type RawDashboard = Omit<DashboardPayload, 'apiVersion' | 'freshness'> & { heartbeats: Heartbeats };

export function freshnessProgramsFromViews(programs: ProgramView[]): FreshnessProgram[] {
  return programs.map((program) => ({
    programKey: program.programKey,
    label: program.label,
    live: program.deployment.status === 'live',
    backfillComplete: program.sync.backfillComplete,
    pending: Number(program.sync.pending) || 0,
    ingested: Number(program.sync.ingested) || 0,
    consecutiveFailures: program.sync.consecutiveFailures,
    completeThrough: program.sync.completeThrough,
  }));
}

export function dashboardFromRaw(raw: RawDashboard, now: Date): DashboardPayload {
  const { heartbeats, ...rest } = raw;
  const schemaVersion = typeof raw.dbSchemaVersion === 'number' ? raw.dbSchemaVersion : null;
  if (schemaVersion === null || schemaVersion < EXPECTED_DB_SCHEMA_VERSION) {
    return setupRequiredDashboard(raw.cluster, raw.window, now, `database schema version ${schemaVersion ?? 'none'}`);
  }
  return {
    apiVersion: DASHBOARD_API_VERSION,
    ...rest,
    freshness: computeFreshness({ now, programs: freshnessProgramsFromViews(raw.programs), heartbeats }),
  };
}

function emptyRange(now: Date): DashboardPayload['range'] {
  return { start: null, end: now.toISOString(), previousStart: null, bucket: 'day' };
}

export function setupRequiredDashboard(cluster: Cluster, window: DashboardWindow, now: Date, detail: string): DashboardPayload {
  return {
    apiVersion: DASHBOARD_API_VERSION,
    dbSchemaVersion: null,
    cluster,
    window,
    generatedAt: now.toISOString(),
    range: emptyRange(now),
    freshness: fixedFreshness(
      'setup_required',
      `Backend upgrade pending: the database migration for this version has not been applied yet (${detail}).`,
    ),
    programs: [],
    kpis: {},
    series: [],
    breakdowns: {},
    migration: null,
    binaries: [],
    latest: [],
    runs: [],
  };
}

export function unavailableBody(cluster: Cluster | null, window: DashboardWindow | null, now: Date, detail: string) {
  return {
    apiVersion: DASHBOARD_API_VERSION,
    cluster,
    window,
    generatedAt: now.toISOString(),
    freshness: fixedFreshness('unavailable', detail),
  };
}

export interface RawHealth {
  schemaVersion: number | null;
  generatedAt: string;
  programs: HealthProgram[];
  heartbeats: Heartbeats;
}

export function healthFromRaw(raw: RawHealth, now: Date): HealthPayload {
  const schemaVersion = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : null;
  if (schemaVersion === null || schemaVersion < EXPECTED_DB_SCHEMA_VERSION) {
    const freshness = fixedFreshness('setup_required', `database schema version ${schemaVersion ?? 'none'}`);
    return {
      apiVersion: DASHBOARD_API_VERSION,
      status: 'setup_required',
      dbSchemaVersion: schemaVersion,
      generatedAt: now.toISOString(),
      completeThrough: null,
      lastWorkerRunAt: null,
      workflowState: 'unknown',
      freshness,
      programs: [],
    };
  }
  const freshness = computeFreshness({
    now,
    heartbeats: raw.heartbeats,
    programs: raw.programs.map((program) => ({
      programKey: program.programKey,
      label: program.label,
      live: program.deployStatus === 'live',
      backfillComplete: program.backfillComplete,
      pending: Number(program.pending) || 0,
      ingested: Number(program.ingested) || 0,
      consecutiveFailures: program.consecutiveFailures,
      completeThrough: program.completeThrough,
    })),
  });
  return {
    apiVersion: DASHBOARD_API_VERSION,
    status: freshness.state,
    dbSchemaVersion: schemaVersion,
    generatedAt: now.toISOString(),
    completeThrough: freshness.completeThrough,
    lastWorkerRunAt: freshness.lastWorkerRunAt,
    workflowState: freshness.workflow.state,
    freshness,
    programs: raw.programs,
  };
}
