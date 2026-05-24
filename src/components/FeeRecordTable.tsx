import { Copy, ExternalLink } from 'lucide-react';
import type { ClusterId } from '../solana/constants';
import type { FeeRecordRow } from '../solana/fetchProtocolStats';
import {
  explorerUrl,
  formatInteger,
  formatLamportsShort,
  shortenAddress,
} from '../solana/format';
import { EmptyState } from './EmptyState';

export function FeeRecordTable({
  cluster,
  rows,
}: {
  cluster: ClusterId;
  rows: FeeRecordRow[];
}) {
  return (
    <section className="panel" aria-label="Fee records">
      <div className="panelHeader">
        <div>
          <p className="eyebrow">Fee Records</p>
          <h2>Top FeeRecord accounts</h2>
        </div>
        <span className="mutedText">Showing top 50 by lifetime fees</span>
      </div>
      <p className="panelNote">
        Fee payer addresses are not stored in the current FeeRecord account
        data. This table shows the canonical record PDA for each tracked payer.
      </p>
      {rows.length === 0 ? (
        <EmptyState
          title="No fee records yet"
          body="FeeRecord accounts will appear here after the first successful fee-paying transaction."
        />
      ) : (
        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>Record PDA</th>
                <th>Total Fees</th>
                <th>Wallets</th>
                <th>Txns</th>
                <th>Registered Slot</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 50).map((row) => (
                <tr key={row.address}>
                  <td>
                    <div className="addressCell">
                      <span title={row.address}>{shortenAddress(row.address)}</span>
                      <button
                        type="button"
                        className="miniIconButton"
                        onClick={() => void navigator.clipboard.writeText(row.address)}
                        aria-label="Copy FeeRecord PDA"
                        title="Copy FeeRecord PDA"
                      >
                        <Copy size={13} />
                      </button>
                      <a
                        className="miniIconButton"
                        href={explorerUrl(row.address, cluster)}
                        target="_blank"
                        rel="noreferrer"
                        aria-label="Open in Explorer"
                        title="Open in Explorer"
                      >
                        <ExternalLink size={13} />
                      </a>
                    </div>
                  </td>
                  <td>{formatLamportsShort(row.totalFeesPaidLamports)}</td>
                  <td>{formatInteger(row.walletCount)}</td>
                  <td>{formatInteger(row.txCount)}</td>
                  <td>{formatInteger(row.registeredAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
