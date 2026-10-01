import { useState } from 'react';
import type { Cluster, LatestRow } from '../types/dashboard';
import { FAIL_CLASS_DEFINITIONS, INSTRUCTION_NAMES } from '../types/protocol';
import { AUTH_BY_CODE, FAIL_LABELS, txVersionLabel } from '../app/selectors';
import type { VersionFilter } from '../app/urlState';
import { exactLamports, formatAge, formatLamports, formatUtc, toBigInt } from '../lib/format';
import { EmptyState } from './EmptyState';
import { AddressLink, SectionHeader, VersionTag } from './ui';

export const PAGE_SIZE = 10;

export function filterLatest(rows: LatestRow[], version: VersionFilter): LatestRow[] {
  return version === 'all' ? rows : rows.filter((row) => String(row.version) === version);
}

export function instructionText(row: LatestRow): string {
  const names = row.kinds.map((kind) => INSTRUCTION_NAMES[kind] ?? `kind ${kind}`);
  const counted = new Map<string, number>();
  for (const name of names) counted.set(name, (counted.get(name) ?? 0) + 1);
  return [...counted.entries()].map(([name, count]) => (count > 1 ? `${count} × ${name}` : name)).join(' + ');
}

/** Section 9: the 50 newest transactions with real LazorKit instructions, 10 per page (keyed by the parent on
 * cluster and version, so the page resets when either changes). */
export function LatestTransactionsTable({ rows, cluster, version, now }: { rows: LatestRow[]; cluster: Cluster; version: VersionFilter; now: number }) {
  const filtered = filterLatest(rows, version);
  const [page, setPage] = useState(1);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const visible = filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  return (
    <section className="panel" aria-labelledby="latest-title">
      <SectionHeader
        id="latest-title"
        eyebrow="Activity"
        title="Latest activity"
        aside={<span className="mutedText">Newest {filtered.length} with a LazorKit instruction · not limited by the time range</span>}
      />
      {filtered.length === 0 ? (
        <EmptyState title="No transactions yet" body="Transactions appear here after the indexer has ingested them." />
      ) : (
        <>
          <div className="tableWrap">
            <table className="latestTable">
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Version</th>
                  <th scope="col">Instruction</th>
                  <th scope="col">Status</th>
                  <th scope="col">Wallet</th>
                  <th scope="col">Signer</th>
                  <th scope="col" className="num">Fee</th>
                  <th scope="col">App</th>
                  <th scope="col">Tx</th>
                  <th scope="col">Signature</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr key={`${row.programKey}-${row.signature}`}>
                    <td>
                      <span className="cellMain">{formatAge(row.blockTime, now)}</span>
                      <span className="cellSub">{formatUtc(row.blockTime, now, { alwaysDate: true })}</span>
                    </td>
                    <td>
                      <VersionTag version={row.version} />
                    </td>
                    <td>
                      {instructionText(row)}
                      {row.inner ? (
                        <span className="cellSub" title="Called by another program (CPI)">
                          via another program
                        </span>
                      ) : null}
                    </td>
                    <td>
                      {row.ok ? (
                        <span className="statusBadge success">✓ ok</span>
                      ) : (
                        <span
                          className="statusBadge failed"
                          title={row.failClass ? FAIL_CLASS_DEFINITIONS[row.failClass] : undefined}
                        >
                          ✕ {row.failClass ? FAIL_LABELS[row.failClass] : 'failed'}
                          {row.errCode !== null ? ` (${row.errCode})` : ''}
                        </span>
                      )}
                    </td>
                    <td>
                      <AddressLink address={row.wallet} cluster={cluster} label="wallet" />
                    </td>
                    <td>{row.auth !== null ? AUTH_BY_CODE[row.auth] ?? '–' : '–'}</td>
                    <td className="num" title={exactLamports(row.feeLamports)}>
                      {toBigInt(row.feeLamports) === 0n ? <span className="mutedText">–</span> : formatLamports(row.feeLamports)}
                    </td>
                    <td className="appCell" title={row.app ?? undefined}>
                      {row.app ?? <span className="mutedText">–</span>}
                    </td>
                    <td>{txVersionLabel(row.txVersion)}</td>
                    <td>
                      <AddressLink address={row.signature} cluster={cluster} label="transaction" kind="tx" chars={6} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <nav className="paginationBar" aria-label="Latest activity pages">
            <span>
              {(current - 1) * PAGE_SIZE + 1}–{Math.min(filtered.length, current * PAGE_SIZE)} of {filtered.length}
            </span>
            <div className="paginationControls">
              <button type="button" onClick={() => setPage(current - 1)} disabled={current <= 1}>
                Previous
              </button>
              {Array.from({ length: pages }, (_, index) => index + 1).map((number) => (
                <button
                  key={number}
                  type="button"
                  aria-current={number === current ? 'page' : undefined}
                  className={number === current ? 'active' : undefined}
                  onClick={() => setPage(number)}
                >
                  {number}
                </button>
              ))}
              <button type="button" onClick={() => setPage(current + 1)} disabled={current >= pages}>
                Next
              </button>
            </div>
          </nav>
        </>
      )}
    </section>
  );
}
