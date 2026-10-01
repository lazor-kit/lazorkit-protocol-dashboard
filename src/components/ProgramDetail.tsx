import { useState } from 'react';
import type { Breakdowns, DashboardPayload, FailClass, Kpis, ProgramView, ScopeKey } from '../types/dashboard';
import { FAIL_CLASS_DEFINITIONS, INSTRUCTION_NAMES } from '../types/protocol';
import {
  AUTH_LABELS,
  FAIL_LABELS,
  KNOWN_PROGRAMS,
  deploymentNote,
  visiblePrograms,
  windowLabel,
} from '../app/selectors';
import type { VersionFilter } from '../app/urlState';
import { exactLamports, formatInteger, formatLamports, formatPercent, formatUtc, ratio, toBigInt } from '../lib/format';
import { FeeRecordTable } from './FeeRecordTable';
import { ShardTable } from './ShardTable';
import { AddressLink, BarList, StatRow, VersionTag, type BarItem } from './ui';

const EMPTY_BREAKDOWNS: Breakdowns = { byKind: {}, byAuth: {}, byFail: {}, byApp: [], byPayer: [], byCpi: [] };

function ActivityMix({ program, kpis, breakdowns, payload }: { program: ProgramView; kpis: Kpis | null; breakdowns: Breakdowns; payload: DashboardPayload }) {
  const kindItems: BarItem[] = Object.entries(breakdowns.byKind)
    .map(([kind, counts]) => ({
      key: kind,
      label: INSTRUCTION_NAMES[Number(kind)] ?? `kind ${kind}`,
      value: counts.ok,
      detail: counts.fail > 0 ? <span className="warningText"> · {formatInteger(counts.fail)} failed</span> : undefined,
    }))
    .sort((a, b) => b.value - a.value);
  const authItems: BarItem[] = Object.entries(breakdowns.byAuth)
    .filter(([, value]) => (value ?? 0) > 0)
    .map(([auth, value]) => ({ key: auth, label: AUTH_LABELS[auth] ?? auth, value: value ?? 0 }))
    .sort((a, b) => b.value - a.value);
  const failItems: BarItem[] = Object.entries(breakdowns.byFail)
    .filter(([, value]) => (value ?? 0) > 0)
    .map(([klass, value]) => ({
      key: klass,
      label: FAIL_LABELS[klass as FailClass] ?? klass,
      value: value ?? 0,
      title: FAIL_CLASS_DEFINITIONS[klass as FailClass],
    }))
    .sort((a, b) => b.value - a.value);
  const appItems: BarItem[] = breakdowns.byApp.map((app) => ({
    key: app.app,
    label: <span className="mono">{app.app}</span>,
    value: app.created + app.ops,
    detail: (
      <span className="mutedText">
        {' '}
        · {formatInteger(app.created)} created · {formatInteger(app.ops)} ops
      </span>
    ),
  }));
  const cpiItems: BarItem[] = breakdowns.byCpi.map((entry) => ({
    key: entry.program,
    label: KNOWN_PROGRAMS[entry.program] ? (
      <span title={entry.program}>{KNOWN_PROGRAMS[entry.program]}</span>
    ) : (
      <AddressLink address={entry.program} cluster={program.cluster} label="program" />
    ),
    value: entry.executes,
  }));
  const payerItems: BarItem[] = breakdowns.byPayer.map((entry) => ({
    key: entry.payer,
    label: <AddressLink address={entry.payer} cluster={program.cluster} label="fee payer" />,
    value: entry.txs,
  }));
  const txv1Share = kpis ? ratio(kpis.txv1, kpis.txs) : null;

  return (
    <div className="detailColumns">
      <div className="detailBlock">
        <h4>Instructions</h4>
        <BarList items={kindItems} unit="ok" />
      </div>
      <div className="detailBlock">
        <h4>Signers</h4>
        <BarList items={authItems} empty="No executions or authorizations in this window" />
        <p className="detailNote">Successful Execute and ExecuteDeferred by how they were authorized.</p>
      </div>
      <div className="detailBlock">
        <h4>Failures by class</h4>
        <BarList items={failItems} empty="No failed transactions in this window" />
        <details className="definitions">
          <summary>What the classes mean</summary>
          <dl>
            {(Object.keys(FAIL_LABELS) as FailClass[]).map((klass) => (
              <div key={klass}>
                <dt>{FAIL_LABELS[klass]}</dt>
                <dd>{FAIL_CLASS_DEFINITIONS[klass]}</dd>
              </div>
            ))}
          </dl>
        </details>
      </div>
      <div className="detailBlock">
        <h4>Integrators</h4>
        <BarList items={appItems} empty="No passkey operations with an origin in this window" />
        <p className="detailNote">From the passkey rpId and WebAuthn origin; top 10.</p>
      </div>
      <div className="detailBlock">
        <h4>Programs wallets call</h4>
        <BarList items={cpiItems} empty="No executions in this window" unit="executions" />
      </div>
      <div className="detailBlock">
        <h4>Relayers (fee payers)</h4>
        <BarList items={payerItems} empty="No relayed transactions in this window" unit="txs" />
        <dl className="statList compact">
          <StatRow label="Distinct payers" value={formatInteger(kpis?.payers ?? 0)} />
          <StatRow label="Network fees paid" value={formatLamports(kpis?.netFeeLamports ?? '0')} title={exactLamports(kpis?.netFeeLamports ?? '0')} />
          {program.version === 2 ? (
            <StatRow
              label="Transaction v1 (SIMD-0385)"
              value={formatPercent(txv1Share)}
              hint={kpis ? `${formatInteger(kpis.txv1)} of ${formatInteger(kpis.txs)}` : null}
            />
          ) : null}
        </dl>
      </div>
      <p className="detailFootnote">Activity figures cover the {windowLabel(payload.window)}.</p>
    </div>
  );
}

function StateBlock({ program, now }: { program: ProgramView; now: number }) {
  const state = program.state;
  if (!state) return <p className="emptyLine">No on-chain snapshot yet.</p>;
  return (
    <div className="detailColumns">
      <div className="detailBlock">
        <h4>Wallets</h4>
        <dl className="statList compact">
          <StatRow label="Wallet accounts" value={formatInteger(state.wallets)} />
          <StatRow label="Passkey owner" value={formatInteger(state.ownerTypes.passkeyWallets)} />
          <StatRow label="Ed25519 owner" value={formatInteger(state.ownerTypes.ed25519Wallets)} />
          <StatRow label="Both owner types" value={formatInteger(state.ownerTypes.mixedWallets)} />
          {state.multiOwnerWallets !== null ? <StatRow label="Multi-owner (v2)" value={formatInteger(state.multiOwnerWallets)} /> : null}
          <StatRow label="Vault SOL" value={formatLamports(state.vaults.lamports)} title={exactLamports(state.vaults.lamports)} hint={`${formatInteger(state.vaults.funded)} funded`} />
        </dl>
      </div>
      <div className="detailBlock">
        <h4>Authorities</h4>
        <dl className="statList compact">
          <StatRow label="Total" value={formatInteger(state.authorities.total)} />
          <StatRow label="Owner / admin / delegate" value={`${formatInteger(state.authorities.owner)} / ${formatInteger(state.authorities.admin)} / ${formatInteger(state.authorities.delegate)}`} />
          <StatRow label="Passkey / Ed25519" value={`${formatInteger(state.authorities.passkey)} / ${formatInteger(state.authorities.ed25519)}`} />
          {state.authorities.legacyLayout > 0 ? <StatRow label="Legacy layout" value={formatInteger(state.authorities.legacyLayout)} /> : null}
          <StatRow
            label="Passkey operations, lifetime"
            value={formatInteger(state.passkeyOpsLifetime)}
            title="Sum of the passkey counters; resets when an authority is removed and re-added"
          />
        </dl>
      </div>
      <div className="detailBlock">
        <h4>Sessions and deferred</h4>
        <dl className="statList compact">
          <StatRow label="Sessions live / expired" value={`${formatInteger(state.sessions.live)} / ${formatInteger(state.sessions.expired)}`} hint={`${formatInteger(state.sessions.withPolicy)} with a policy`} />
          <StatRow label="Deferred pending / expired" value={`${formatInteger(state.deferred.pending)} / ${formatInteger(state.deferred.expired)}`} />
          <StatRow
            label="Rent held by expired deferred"
            value={formatLamports(state.deferred.expiredLamports)}
            title={exactLamports(state.deferred.expiredLamports)}
          />
        </dl>
        <p className="detailNote">Expired sessions and deferred executions stay on chain until someone closes them.</p>
      </div>
      <p className="detailFootnote">
        Snapshot at slot {formatInteger(program.stateSlot ?? state.slot)}
        {program.stateFetchedAt ? `, ${formatUtc(program.stateFetchedAt, now, { alwaysDate: true })}` : ''} · {formatInteger(state.accounts)} program
        accounts{state.unknownAccounts > 0 ? `, ${formatInteger(state.unknownAccounts)} unrecognised` : ''}.
      </p>
    </div>
  );
}

function FeesBlock({ program, kpis }: { program: ProgramView; kpis: Kpis | null }) {
  const state = program.state;
  if (!state) return <p className="emptyLine">No on-chain snapshot yet.</p>;
  const config = state.config;
  const configLabel =
    config === null
      ? program.version === 2
        ? 'Fees not configured'
        : 'No ProtocolConfig account'
      : config.enabled
        ? 'Fees on'
        : program.version === 1
          ? 'Fees off; wallets unaffected'
          : 'Fees off';
  const treasury = program.treasury;
  const shardRent = toBigInt(state.rentMinimum8) * BigInt(state.treasury.shards);
  const feeRecords = program.stateDetail?.feeRecords ?? state.feeRecords.top;
  const suffixShare = kpis ? ratio(kpis.feeSuffixOk, kpis.feeEligibleOk) : null;
  const unpaidShare = kpis ? ratio(Math.max(0, kpis.feeEligibleOk - kpis.feeEvents), kpis.feeEligibleOk) : null;

  return (
    <>
      <div className="detailColumns">
        <div className="detailBlock">
          <h4>Fee config</h4>
          <dl className="statList compact">
            <StatRow label="Status" value={configLabel} />
            {config ? (
              <>
                <StatRow label="Creation / execution fee" value={`${formatLamports(config.creationFee)} / ${formatLamports(config.executionFee)}`} />
                <StatRow label="Treasury shards" value={formatInteger(config.numShards)} />
                <StatRow label="Admin" value={<AddressLink address={config.admin} cluster={program.cluster} label="admin" copy />} />
                <StatRow label="Treasury" value={<AddressLink address={config.treasury} cluster={program.cluster} label="treasury" copy />} />
                {config.pendingAdmin ? <StatRow label="Pending admin" value={<AddressLink address={config.pendingAdmin} cluster={program.cluster} label="pending admin" />} /> : null}
                <StatRow label="Config account" value={<AddressLink address={config.address} cluster={program.cluster} label="config" copy />} />
              </>
            ) : null}
          </dl>
          {program.version === 1 && config && !config.enabled ? (
            <p className="detailNote">The lenient v1 build keeps wallets working when fees are off; it is not a pause.</p>
          ) : null}
        </div>
        <div className="detailBlock">
          <h4>Treasury</h4>
          {treasury ? (
            <>
              <dl className="statList compact">
                <StatRow label="Unwithdrawn fees" value={formatLamports(treasury.unwithdrawnFeesLamports)} title={exactLamports(treasury.unwithdrawnFeesLamports)} />
                <StatRow label="Withdrawable now" value={formatLamports(treasury.withdrawableNowLamports)} title={exactLamports(treasury.withdrawableNowLamports)} />
                <StatRow label="Withdrawn so far" value={formatLamports(treasury.withdrawnLamports)} title={exactLamports(treasury.withdrawnLamports)} />
              </dl>
              {toBigInt(treasury.excessRentLamports) !== 0n ? (
                <p className="detailNote">
                  Withdrawable now differs from unwithdrawn fees by {formatLamports(treasury.excessRentLamports)} of excess rent: the{' '}
                  {formatInteger(state.treasury.shards)} shards were funded with {formatLamports(treasury.fundingLamports)} and need only{' '}
                  {formatLamports(shardRent)} to stay rent-exempt today.
                </p>
              ) : null}
            </>
          ) : (
            <p className="emptyLine">No treasury shards yet.</p>
          )}
        </div>
        <div className="detailBlock">
          <h4>Fee records</h4>
          <dl className="statList compact">
            <StatRow label="Records" value={formatInteger(state.feeRecords.count)} />
            <StatRow
              label={program.version === 1 ? 'Fees recorded (lower bound)' : 'Lifetime fees (exact)'}
              value={formatLamports(state.feeRecords.totalFeesPaid)}
              title={exactLamports(state.feeRecords.totalFeesPaid)}
            />
            <StatRow label="Transactions / wallets" value={`${formatInteger(state.feeRecords.txCount)} / ${formatInteger(state.feeRecords.walletCount)}`} />
          </dl>
          <p className="detailNote">
            {program.version === 1
              ? 'v1 FeeRecords count registered payers only, so they are a lower bound; fee history above comes from transactions.'
              : 'v2 FeeRecords count every fee-paying transaction: exact lifetime fees.'}
          </p>
        </div>
        <div className="detailBlock">
          <h4>Fee coverage, this window</h4>
          <dl className="statList compact">
            <StatRow label="Fee-eligible operations" value={formatInteger(kpis?.feeEligibleOk ?? 0)} />
            <StatRow label="Fee-paying events" value={formatInteger(kpis?.feeEvents ?? 0)} />
            <StatRow label="Unpaid share" value={formatPercent(unpaidShare)} />
            {program.version === 1 ? (
              <StatRow label="Fee suffix adoption" value={formatPercent(suffixShare)} hint={kpis ? `${formatInteger(kpis.feeSuffixOk)} of ${formatInteger(kpis.feeEligibleOk)}` : null} />
            ) : (
              <StatRow label="Fee suffix" value="mandatory in v2" />
            )}
          </dl>
        </div>
      </div>
      <ShardTable cluster={program.cluster} shards={program.stateDetail?.shards ?? []} rentMinimum={state.rentMinimum8} />
      <FeeRecordTable cluster={program.cluster} rows={feeRecords} total={state.feeRecords.count} lowerBound={program.version === 1} />
    </>
  );
}

/** Section 6: per-program detail, one tab per protocol version (following the version filter). */
export function ProgramDetail({ payload, version, now }: { payload: DashboardPayload; version: VersionFilter; now: number }) {
  const programs = visiblePrograms(payload, version);
  const [selected, setSelected] = useState<number | null>(null);
  const program = programs.find((entry) => entry.programKey === selected) ?? programs[0];
  if (!program) return null;
  const scope = String(program.programKey) as ScopeKey;
  const kpis = payload.kpis[scope]?.current ?? null;
  const breakdowns = payload.breakdowns[scope] ?? EMPTY_BREAKDOWNS;

  return (
    <section className="panel" aria-labelledby="program-detail-title">
      <div className="panelHeader">
        <div>
          <p className="eyebrow">Per program</p>
          <h2 id="program-detail-title">Program detail</h2>
        </div>
        {programs.length > 1 ? (
          <div className="tabs" role="tablist" aria-label="Program">
            {programs.map((entry) => (
              <button
                key={entry.programKey}
                type="button"
                role="tab"
                id={`program-tab-${entry.programKey}`}
                aria-selected={entry.programKey === program.programKey}
                aria-controls="program-detail-panel"
                className={entry.programKey === program.programKey ? 'active' : undefined}
                onClick={() => setSelected(entry.programKey)}
              >
                <VersionTag version={entry.version} /> {entry.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div id="program-detail-panel" role={programs.length > 1 ? 'tabpanel' : undefined} aria-labelledby={programs.length > 1 ? `program-tab-${program.programKey}` : undefined}>
        {program.deployment.status !== 'live' ? (
          <p className="programCardNote">{deploymentNote(program, payload.binaries)}</p>
        ) : (
          <>
            <h3 className="detailHeading">Activity mix</h3>
            <ActivityMix program={program} kpis={kpis} breakdowns={breakdowns} payload={payload} />
            <h3 className="detailHeading">On-chain state</h3>
            <StateBlock program={program} now={now} />
            <h3 className="detailHeading">Fees and treasury</h3>
            <FeesBlock program={program} kpis={kpis} />
          </>
        )}
      </div>
    </section>
  );
}
