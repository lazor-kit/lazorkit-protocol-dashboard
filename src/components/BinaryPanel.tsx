import type { DashboardPayload, DeployHistoryEntry, ProgramView } from '../types/dashboard';
import { expectedNextBinary, notDeployedCopy, programBadge, releaseMatchLabel } from '../app/selectors';
import { formatBytes, formatInteger, formatUtc, shortHash } from '../lib/format';
import { AddressLink, CopyButton, Pill, SectionHeader, StatRow, VersionTag } from './ui';

const OP_LABELS: Record<DeployHistoryEntry['op'], string> = {
  deploy: 'Deploy',
  upgrade: 'Upgrade',
  extend: 'Extend program',
  observed: 'Hash observed',
};

function Hash({ sha256 }: { sha256: string | null }) {
  if (!sha256) return <span className="mutedText">–</span>;
  return (
    <span className="addressCell">
      <code title={sha256}>{shortHash(sha256)}</code>
      <CopyButton value={sha256} label="sha256" />
    </span>
  );
}

function BinaryRow({ program, payload, now, open }: { program: ProgramView; payload: DashboardPayload; now: number; open: boolean }) {
  const badge = programBadge(program, now);
  const match = releaseMatchLabel(program);
  const next = expectedNextBinary(program, payload.binaries);
  const { deployment } = program;
  const history = [...deployment.history].sort((a, b) => b.slot - a.slot || a.op.localeCompare(b.op));
  return (
    <article className="binaryRow" aria-label={`${program.label} binary`}>
      <header className="programCardHeader">
        <h3>
          <VersionTag version={program.version} /> {program.label}
        </h3>
        <Pill tone={badge.tone}>{badge.label}</Pill>
      </header>
      {deployment.status !== 'live' ? (
        <>
          <p className="programCardNote">{notDeployedCopy(program, payload.binaries)}</p>
          <dl className="statList">
            <StatRow
              label="Expected build"
              value={next ? <code title={next.binary.sha256}>{shortHash(next.binary.sha256)}</code> : 'not published yet'}
              hint={next ? `${next.binary.label} · ${formatBytes(next.binary.elfSize)}` : null}
              title={next?.binary.source}
            />
          </dl>
        </>
      ) : (
        <dl className="statList">
          <StatRow label="Build" value={deployment.binaryLabel ?? (deployment.status === 'live' ? 'unrecognised' : '–')} />
          <StatRow label="sha256 (ELF)" value={<Hash sha256={deployment.sha256} />} />
          <StatRow label="ELF size" value={formatBytes(deployment.elfSize)} />
          <StatRow
            label="Release match"
            value={<span className={match.ok === false ? 'warningText' : match.ok ? 'goodText' : undefined}>{match.text}</span>}
            title={match.title ?? undefined}
          />
          <StatRow
            label="Last deploy"
            value={deployment.lastDeploySlot ? `slot ${formatInteger(deployment.lastDeploySlot)}` : '–'}
            hint={deployment.deployedAt ? formatUtc(deployment.deployedAt, now, { alwaysDate: true }) : null}
          />
          <StatRow label="Upgrade authority" value={<AddressLink address={deployment.upgradeAuthority} cluster={program.cluster} label="upgrade authority" copy />} />
          <StatRow
            label="Expected next"
            value={
              next ? (
                <>
                  {next.label} <code title={next.binary.sha256}>{shortHash(next.binary.sha256)}</code> ({formatBytes(next.binary.elfSize)})
                </>
              ) : deployment.binaryKind === 'v1-sunset' ? (
                'final v1 build (sunset)'
              ) : (
                'nothing pending'
              )
            }
            title={next ? `${next.binary.label} · ${next.binary.source}` : undefined}
          />
        </dl>
      )}
      {history.length > 0 ? (
        <details className="subTable" open={open}>
          <summary>Deploy history ({history.length})</summary>
          <div className="tableWrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Operation</th>
                  <th scope="col" className="num">Slot</th>
                  <th scope="col">Time</th>
                  <th scope="col">Transaction</th>
                  <th scope="col">sha256</th>
                </tr>
              </thead>
              <tbody>
                {history.map((entry) => (
                  <tr key={`${entry.slot}-${entry.op}-${entry.signature ?? ''}`}>
                    <td>{OP_LABELS[entry.op]}</td>
                    <td className="num">{formatInteger(entry.slot)}</td>
                    <td>{entry.at ? formatUtc(entry.at, now, { alwaysDate: true }) : '–'}</td>
                    <td>
                      <AddressLink address={entry.signature} cluster={program.cluster} label="transaction" kind="tx" chars={6} />
                    </td>
                    <td>
                      <Hash sha256={entry.sha256} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </article>
  );
}

/** Section 7: deployed binaries vs the known builds (release-hashes.txt and program dumps), and upgrades. */
export function BinaryPanel({ payload, now, expandAll }: { payload: DashboardPayload; now: number; expandAll: boolean }) {
  const programs = [...payload.programs].sort((a, b) => a.version - b.version);
  return (
    <section className="panel" aria-labelledby="binary-title">
      <SectionHeader
        id="binary-title"
        eyebrow="Binaries and upgrades"
        title="What is deployed"
        aside={<span className="mutedText">ELF sha256 compared with release-hashes.txt and known program dumps</span>}
      />
      <div className="binaryGrid">
        {programs.map((program) => (
          <BinaryRow key={program.programKey} program={program} payload={payload} now={now} open={expandAll} />
        ))}
      </div>
    </section>
  );
}
