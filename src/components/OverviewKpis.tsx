import type { DashboardPayload, Kpis } from '../types/dashboard';
import {
  clusterKeys,
  kpiDelta,
  kpisFor,
  previousLabel,
  scopeForVersion,
  stateSummary,
  versionSplit,
  windowLabel,
} from '../app/selectors';
import type { VersionFilter } from '../app/urlState';
import { exactLamports, formatInteger, formatLamports, formatPercent, formatUtc, ratio, toBigInt } from '../lib/format';
import { KpiCard } from './KpiCard';

function Split({ v1, v2, v2Missing }: { v1: string | null; v2: string | null; v2Missing: string }) {
  return (
    <>
      <span className="splitItem">
        <span className="seriesSwatch seriesSwatch-v1" aria-hidden="true" />v1 {v1 ?? '–'}
      </span>
      <span aria-hidden="true"> · </span>
      <span className="splitItem">
        <span className="seriesSwatch seriesSwatch-v2" aria-hidden="true" />v2 {v2 ?? v2Missing}
      </span>
    </>
  );
}

/** Section 3: overview across versions for the scope chosen by the version filter ("All" = cluster). */
export function OverviewKpis({ payload, version, now }: { payload: DashboardPayload; version: VersionFilter; now: number }) {
  const scope = scopeForVersion(payload.cluster, version);
  const entry = kpisFor(payload, scope);
  const keys = clusterKeys(payload.cluster);
  const v2Program = payload.programs.find((program) => program.programKey === keys.v2);
  const v2Missing = v2Program && v2Program.deployment.status !== 'live' ? 'not deployed' : '–';
  const state = stateSummary(payload, version);
  const showSplit = version === 'all';
  const deltaLabel = previousLabel(payload.window);
  const allHistory = payload.window === 'all' ? 'all history' : undefined;

  if (!entry) {
    return (
      <section className="panel" aria-label="Overview">
        <p className="emptyLine">No figures for this selection.</p>
      </section>
    );
  }
  const { current, previous } = entry;
  const split = (pick: (kpis: Kpis) => number) => {
    if (!showSplit) return undefined;
    const values = versionSplit(payload, pick);
    return (
      <Split
        v1={values.v1 === null ? null : formatInteger(values.v1)}
        v2={v2Missing === 'not deployed' ? null : values.v2 === null ? null : formatInteger(values.v2)}
        v2Missing={v2Missing}
      />
    );
  };
  const lamportSplit = (pick: (kpis: Kpis) => string) => {
    if (!showSplit) return undefined;
    const v1 = payload.kpis[String(keys.v1) as '1']?.current;
    const v2 = payload.kpis[String(keys.v2) as '2']?.current;
    return (
      <Split
        v1={v1 ? formatLamports(pick(v1)) : null}
        v2={v2Missing === 'not deployed' || !v2 ? null : formatLamports(pick(v2))}
        v2Missing={v2Missing}
      />
    );
  };

  const successRate = ratio(current.txsOk, current.txs);
  const protocolErrorRate = ratio(current.failByClass.lazorkit ?? 0, current.txs);
  const passkeyShare = ratio(current.walletsCreatedPasskey, current.walletsCreated);
  const fees = toBigInt(current.feeLamports);
  const averageFee = current.feeEvents > 0 ? fees / BigInt(current.feeEvents) : null;

  return (
    <section className="kpiGrid" aria-label={`Overview, ${windowLabel(payload.window)}`}>
      <KpiCard
        label="Transactions"
        value={formatInteger(current.txs)}
        delta={kpiDelta(current.txs, previous?.txs)}
        deltaLabel={deltaLabel || allHistory}
        split={split((k) => k.txs)}
        sub={
          <>
            Success {formatPercent(successRate)} · protocol errors {formatPercent(protocolErrorRate)}
          </>
        }
      />
      <KpiCard
        label="Active wallets"
        value={formatInteger(current.activeWallets)}
        delta={kpiDelta(current.activeWallets, previous?.activeWallets)}
        deltaLabel={deltaLabel || allHistory}
        split={split((k) => k.activeWallets)}
        sub="Distinct wallets with a successful operation"
      />
      <KpiCard
        label="Wallets created"
        value={formatInteger(current.walletsCreated)}
        delta={kpiDelta(current.walletsCreated, previous?.walletsCreated)}
        deltaLabel={deltaLabel || allHistory}
        split={split((k) => k.walletsCreated)}
        sub={<>Passkey share {formatPercent(passkeyShare)}</>}
      />
      <KpiCard
        label="Protocol fees"
        value={formatLamports(current.feeLamports)}
        title={exactLamports(current.feeLamports)}
        delta={kpiDelta(Number(fees), previous ? Number(toBigInt(previous.feeLamports)) : null)}
        deltaLabel={deltaLabel || allHistory}
        split={lamportSplit((k) => k.feeLamports)}
        sub={
          <>
            {formatInteger(current.feeEvents)} fee-paying events
            {averageFee !== null ? <> · avg {formatLamports(averageFee)}</> : null}
          </>
        }
      />
      <KpiCard
        label="Wallets existing"
        value={state.programs > 0 ? formatInteger(state.wallets) : '–'}
        deltaLabel={state.fetchedAt ? `On-chain snapshot · ${formatUtc(state.fetchedAt, now)}` : 'On-chain snapshot'}
        split={
          showSplit ? (
            <Split
              v1={state.perVersion.v1 ? formatInteger(state.perVersion.v1.wallets) : null}
              v2={state.perVersion.v2 ? formatInteger(state.perVersion.v2.wallets) : null}
              v2Missing={v2Missing}
            />
          ) : undefined
        }
        sub={state.slot ? <>Wallet accounts at slot {formatInteger(state.slot)}</> : 'No snapshot yet'}
      />
      <KpiCard
        label="Vault SOL"
        value={state.programs > 0 ? formatLamports(state.vaultLamports) : '–'}
        title={exactLamports(state.vaultLamports)}
        deltaLabel={state.fetchedAt ? `On-chain snapshot · ${formatUtc(state.fetchedAt, now)}` : 'On-chain snapshot'}
        split={
          showSplit ? (
            <Split
              v1={state.perVersion.v1 ? formatLamports(state.perVersion.v1.vaultLamports) : null}
              v2={state.perVersion.v2 ? formatLamports(state.perVersion.v2.vaultLamports) : null}
              v2Missing={v2Missing}
            />
          ) : undefined
        }
        sub={<>{formatInteger(state.fundedVaults)} funded wallet vaults · SOL only</>}
      />
    </section>
  );
}
