// A small hand-written runtime validator for DashboardPayload (no schema library). Returns a list of problems;
// empty means the value matches the contract in ./dashboard.ts closely enough for the SPA to trust it.

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const isNullableString = (value: unknown) => value === null || isString(value);
const isLamports = (value: unknown) => isString(value) && /^-?\d+$/.test(value);
const isIso = (value: unknown) => isString(value) && !Number.isNaN(Date.parse(value));

const KPI_NUMBERS = ['signatures', 'txs', 'txsOk', 'txsFailed', 'noiseTxs', 'unparsedTxs', 'ixs', 'walletsCreated',
  'walletsCreatedPasskey', 'activeWallets', 'payers', 'apps', 'executes', 'feeEvents', 'feeEligibleOk', 'feeSuffixOk',
  'migrations', 'migratedTokenAccounts', 'retiredCalls', 'txv1'];
const KPI_LAMPORTS = ['feeLamports', 'migratedLamports', 'shardFundingLamports', 'withdrawnLamports', 'netFeeLamports', 'cleanupLamports'];

function checkKpis(kpis: unknown, path: string, problems: string[]) {
  if (!isObject(kpis)) {
    problems.push(`${path}: not an object`);
    return;
  }
  for (const key of KPI_NUMBERS) if (!isNumber(kpis[key])) problems.push(`${path}.${key}: not a number`);
  for (const key of KPI_LAMPORTS) if (!isLamports(kpis[key])) problems.push(`${path}.${key}: not a lamport string`);
  if (!isObject(kpis.failByClass)) problems.push(`${path}.failByClass: not an object`);
  if (isNumber(kpis.txs) && isNumber(kpis.txsOk) && isNumber(kpis.txsFailed) && kpis.txs !== kpis.txsOk + kpis.txsFailed) {
    problems.push(`${path}: txs != txsOk + txsFailed`);
  }
}

export function validateDashboardPayload(value: unknown): string[] {
  const problems: string[] = [];
  if (!isObject(value)) return ['payload: not an object'];
  if (value.apiVersion !== 2) problems.push('apiVersion: expected 2');
  if (value.cluster !== 'mainnet' && value.cluster !== 'devnet') problems.push('cluster: invalid');
  if (!['24h', '7d', '30d', 'all'].includes(value.window as string)) problems.push('window: invalid');
  if (!isIso(value.generatedAt)) problems.push('generatedAt: not ISO');
  if (!(value.dbSchemaVersion === null || isNumber(value.dbSchemaVersion))) problems.push('dbSchemaVersion: invalid');
  const range = value.range;
  if (!isObject(range) || !(range.start === null || isIso(range.start)) || !isIso(range.end) ||
      !(range.previousStart === null || isIso(range.previousStart)) ||
      !(range.previousEnd === undefined || range.previousEnd === null || isIso(range.previousEnd)) ||
      !['hour', 'day'].includes(range.bucket as string)) {
    problems.push('range: invalid');
  }
  const freshness = value.freshness;
  if (!isObject(freshness) || !['live', 'catching_up', 'delayed', 'stale', 'unavailable', 'setup_required'].includes(freshness.state as string) ||
      !Array.isArray(freshness.reasons) || !Array.isArray(freshness.catchUp) || !isObject(freshness.workflow)) {
    problems.push('freshness: invalid');
  }
  if (!Array.isArray(value.programs)) problems.push('programs: not an array');
  else {
    value.programs.forEach((program, i) => {
      const path = `programs[${i}]`;
      if (!isObject(program)) {
        problems.push(`${path}: not an object`);
        return;
      }
      if (!isNumber(program.programKey) || !(program.version === 1 || program.version === 2) || !isString(program.programId)) {
        problems.push(`${path}: identity`);
      }
      const deployment = program.deployment;
      if (!isObject(deployment) || !['unknown', 'not_deployed', 'live', 'closed'].includes(deployment.status as string) ||
          !Array.isArray(deployment.history) || !isNullableString(deployment.sha256)) {
        problems.push(`${path}.deployment: invalid`);
      }
      const sync = program.sync;
      if (!isObject(sync) || typeof sync.backfillComplete !== 'boolean' || !isNumber(sync.pending) || !isNumber(sync.ingested) ||
          !isNumber(sync.gapsOpen) || !isNumber(sync.activeGen) || !(sync.completeThrough === null || isIso(sync.completeThrough))) {
        problems.push(`${path}.sync: invalid`);
      }
      if (!(program.state === null || isObject(program.state))) problems.push(`${path}.state: invalid`);
      if (isObject(program.state)) {
        const state = program.state;
        if (!isNumber(state.wallets) || !isObject(state.authorities) || !isObject(state.sessions) || !isObject(state.treasury) ||
            !isLamports(state.rentMinimum8)) {
          problems.push(`${path}.state: missing totals`);
        }
      }
      if (!Array.isArray(program.checks)) problems.push(`${path}.checks: not an array`);
      if (program.treasury !== null && !(isObject(program.treasury) && isLamports(program.treasury.withdrawableNowLamports))) {
        problems.push(`${path}.treasury: invalid`);
      }
    });
  }
  if (!isObject(value.kpis)) problems.push('kpis: not an object');
  else {
    for (const [scope, entry] of Object.entries(value.kpis)) {
      if (!isObject(entry)) {
        problems.push(`kpis.${scope}: invalid`);
        continue;
      }
      checkKpis(entry.current, `kpis.${scope}.current`, problems);
      if (entry.previous !== null) checkKpis(entry.previous, `kpis.${scope}.previous`, problems);
    }
  }
  if (!Array.isArray(value.series)) problems.push('series: not an array');
  else {
    value.series.forEach((point, i) => {
      if (!isObject(point) || !isString(point.scope) || !isString(point.bucket) || !isNumber(point.txs) ||
          !isNumber(point.txsFailed) || !isNumber(point.activeWallets) || !isLamports(point.feeLamports)) {
        problems.push(`series[${i}]: invalid`);
      }
    });
  }
  if (!isObject(value.breakdowns)) problems.push('breakdowns: not an object');
  else {
    for (const [scope, entry] of Object.entries(value.breakdowns)) {
      if (!isObject(entry) || !isObject(entry.byKind) || !isObject(entry.byAuth) || !isObject(entry.byFail) ||
          !Array.isArray(entry.byApp) || !Array.isArray(entry.byPayer) || !Array.isArray(entry.byCpi)) {
        problems.push(`breakdowns.${scope}: invalid`);
      }
    }
  }
  if (!(value.migration === null || (isObject(value.migration) && ['not_started', 'active'].includes(value.migration.status as string)))) {
    problems.push('migration: invalid');
  }
  for (const key of ['binaries', 'latest', 'runs']) if (!Array.isArray(value[key])) problems.push(`${key}: not an array`);
  if (Array.isArray(value.latest)) {
    value.latest.forEach((row, i) => {
      if (!isObject(row) || !isString(row.signature) || !isIso(row.blockTime) || !Array.isArray(row.kinds) || typeof row.ok !== 'boolean' ||
          !isLamports(row.feeLamports)) {
        problems.push(`latest[${i}]: invalid`);
      }
    });
    const perProgram = new Map<unknown, number>();
    for (const row of value.latest as Array<Record<string, unknown>>) {
      perProgram.set(row?.programKey, (perProgram.get(row?.programKey) ?? 0) + 1);
    }
    if ([...perProgram.values()].some((n) => n > 50)) problems.push('latest: more than 50 rows for one program');
  }
  return problems;
}
