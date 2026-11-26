import type { Cluster, DashboardPayload } from '../types/dashboard.js';

export function protocolScope(cluster: Cluster): '1' | '3' {
  return cluster === 'mainnet' ? '1' : '3';
}

/** Project the shared index into the public Protocol view without mixing cluster totals. */
export function protocolData<T extends Pick<
  DashboardPayload,
  'cluster' | 'programs' | 'kpis' | 'series' | 'breakdowns' | 'migration' | 'binaries' | 'latest'
>>(data: T): T {
  const scope = protocolScope(data.cluster);
  const key = Number(scope);
  const kpis = data.kpis[scope];
  const breakdowns = data.breakdowns[scope];
  return {
    ...data,
    programs: data.programs.filter(program => program.programKey === key && program.version === 1),
    kpis: kpis ? { [scope]: kpis } : {},
    series: data.series.filter(point => point.scope === scope),
    breakdowns: breakdowns ? { [scope]: breakdowns } : {},
    migration: null,
    binaries: data.binaries.filter(binary => binary.kind === 'v1-full' && (!binary.cluster || binary.cluster === data.cluster)),
    latest: data.latest.filter(row => row.programKey === key && row.version === 1),
  };
}

export function protocolPayload(payload: DashboardPayload): DashboardPayload {
  const key = Number(protocolScope(payload.cluster));
  return {
    ...protocolData(payload),
    freshness: {
      ...payload.freshness,
      reasons: payload.freshness.reasons.filter(reason => reason.programKey === undefined || reason.programKey === key),
      catchUp: payload.freshness.catchUp.filter(progress => progress.programKey === key),
    },
  };
}
