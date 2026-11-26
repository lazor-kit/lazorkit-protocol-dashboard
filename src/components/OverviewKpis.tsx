import type { DashboardPayload } from '../types/dashboard';
import {
  kpiDelta,
  kpisFor,
  previousLabel,
  scopeForVersion,
  stateSummary,
  windowLabel,
} from '../app/selectors';
import { exactLamports, formatInteger, formatLamports, formatPercent, formatUtc, ratio, toBigInt } from '../lib/format';
import { KpiCard } from './KpiCard';

export function OverviewKpis({ payload, now }: { payload: DashboardPayload; now: number }) {
  const entry = kpisFor(payload, scopeForVersion(payload.cluster, '1'));
  const state = stateSummary(payload, '1');
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
  const successRate = ratio(current.txsOk, current.txs);
  const protocolErrorRate = ratio(current.failByClass.lazorkit ?? 0, current.txs);
  const passkeyShare = ratio(current.walletsCreatedPasskey, current.walletsCreated);
  const fees = toBigInt(current.feeLamports);
  const averageFee = current.feeEvents > 0 ? fees / BigInt(current.feeEvents) : null;

  return (
    <section className="kpiGrid" aria-label={`Overview, ${windowLabel(payload.window)}`}>
      <KpiCard
        label="Active wallets"
        value={formatInteger(current.activeWallets)}
        delta={kpiDelta(current.activeWallets, previous?.activeWallets)}
        deltaLabel={deltaLabel || allHistory}
        sub="Wallets with a successful action"
      />
      <KpiCard
        label="Transactions"
        value={formatInteger(current.txs)}
        delta={kpiDelta(current.txs, previous?.txs)}
        deltaLabel={deltaLabel || allHistory}
        sub={
          <>
            Success {formatPercent(successRate)} · protocol errors {formatPercent(protocolErrorRate)}
          </>
        }
      />
      <KpiCard
        label="Protocol fees"
        value={formatLamports(current.feeLamports)}
        title={exactLamports(current.feeLamports)}
        delta={kpiDelta(Number(fees), previous ? Number(toBigInt(previous.feeLamports)) : null)}
        deltaLabel={deltaLabel || allHistory}
        sub={
          <>
            {formatInteger(current.feeEvents)} fee payments
            {averageFee !== null ? <> · avg {formatLamports(averageFee)}</> : null}
          </>
        }
      />
      <KpiCard
        label="Wallets created"
        value={formatInteger(current.walletsCreated)}
        delta={kpiDelta(current.walletsCreated, previous?.walletsCreated)}
        deltaLabel={deltaLabel || allHistory}
        sub={<>Passkey share {formatPercent(passkeyShare)}</>}
      />
      <KpiCard
        label="Wallets on chain"
        value={state.programs > 0 ? formatInteger(state.wallets) : '–'}
        deltaLabel={state.fetchedAt ? `On-chain snapshot · ${formatUtc(state.fetchedAt, now)}` : 'On-chain snapshot'}
        sub={state.slot ? <>Wallet accounts at slot {formatInteger(state.slot)}</> : 'No snapshot yet'}
      />
      <KpiCard
        label="SOL in vaults"
        value={state.programs > 0 ? formatLamports(state.vaultLamports) : '–'}
        title={exactLamports(state.vaultLamports)}
        deltaLabel={state.fetchedAt ? `On-chain snapshot · ${formatUtc(state.fetchedAt, now)}` : 'On-chain snapshot'}
        sub={<>{formatInteger(state.fundedVaults)} funded wallet vaults · SOL only</>}
      />
    </section>
  );
}
