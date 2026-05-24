import { ExternalLink } from 'lucide-react';
import type { LatestTransaction } from '../solana/dashboardTypes';
import type { ClusterId } from '../solana/constants';
import {
  explorerUrl,
  explorerTxUrl,
  formatDateTime,
  formatLamportsShort,
  shortenAddress,
} from '../solana/format';
import { EmptyState } from './EmptyState';

export function LatestTransactionsTable({
  cluster,
  rows,
}: {
  cluster: ClusterId;
  rows: LatestTransaction[];
}) {
  return (
    <section className="panel" aria-label="Latest transactions">
      <div className="panelHeader">
        <div>
          <p className="eyebrow">Transactions</p>
          <h2>Latest transactions</h2>
        </div>
        <span className="mutedText">Recent fee-eligible LazorKit activity</span>
      </div>
      {rows.length === 0 ? (
        <EmptyState
          title="No indexed transactions"
          body="Transactions will appear after the indexer stores LazorKit activity for the selected network and time window."
        />
      ) : (
        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Wallet</th>
                <th>Fee Payer</th>
                <th>Method</th>
                <th>Status</th>
                <th>Fee</th>
                <th>Network</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.signature}>
                  <td>{formatDateTime(row.blockTime)}</td>
                  <td>
                    <AddressActions
                      cluster={cluster}
                      address={row.walletPda}
                      label="wallet PDA"
                    />
                  </td>
                  <td>
                    <AddressActions
                      cluster={cluster}
                      address={row.feePayer}
                      label="fee payer"
                    />
                  </td>
                  <td>{row.method}</td>
                  <td>
                    <span
                      className={`statusBadge ${
                        row.status === 'success' ? 'success' : 'failed'
                      }`}
                    >
                      {row.status}
                    </span>
                  </td>
                  <td>{formatLamportsShort(row.feeLamports)}</td>
                  <td>
                    <a
                      className="networkLink"
                      href={explorerTxUrl(row.signature, cluster)}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="Open transaction in Explorer"
                      title={row.signature}
                    >
                      {cluster}
                      <ExternalLink size={13} />
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function AddressActions({
  cluster,
  address,
  label,
  href,
}: {
  cluster: ClusterId;
  address: string;
  label: string;
  href?: string;
}) {
  return (
    <div className="addressCell">
      <span title={address}>{shortenAddress(address)}</span>
      <a
        className="inlineExplorerLink"
        href={href ?? explorerUrl(address, cluster)}
        target="_blank"
        rel="noreferrer"
        aria-label={`Open ${label} in Explorer`}
        title={`Open ${label} in Explorer`}
      >
        <ExternalLink size={13} />
      </a>
    </div>
  );
}
