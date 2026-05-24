import { ExternalLink } from 'lucide-react';
import type {
  AnalyticsStatus,
  LatestTransaction,
  LatestTransactionsPagination,
} from '../solana/dashboardTypes';
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
  pagination,
  analyticsStatus,
  onPageChange,
}: {
  cluster: ClusterId;
  rows: LatestTransaction[];
  pagination: LatestTransactionsPagination;
  analyticsStatus: AnalyticsStatus;
  onPageChange: (page: number) => void;
}) {
  const firstRow = pagination.total === 0
    ? 0
    : (pagination.page - 1) * pagination.limit + 1;
  const lastRow = Math.min(pagination.total, pagination.page * pagination.limit);

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
          title={emptyCopy(analyticsStatus).title}
          body={emptyCopy(analyticsStatus).body}
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
          <div className="paginationBar">
            <span>
              Showing {firstRow}-{lastRow} of {pagination.total}
            </span>
            <div className="paginationControls">
              <button
                type="button"
                onClick={() => onPageChange(pagination.page - 1)}
                disabled={!pagination.hasPreviousPage}
              >
                Previous
              </button>
              {paginationPages(pagination.totalPages, pagination.page).map((page) => (
                <button
                  key={page}
                  type="button"
                  className={page === pagination.page ? 'active' : undefined}
                  onClick={() => onPageChange(page)}
                >
                  {page}
                </button>
              ))}
              <button
                type="button"
                onClick={() => onPageChange(pagination.page + 1)}
                disabled={!pagination.hasNextPage}
              >
                Next
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function emptyCopy(status: AnalyticsStatus): { title: string; body: string } {
  if (status === 'empty' || status === 'not_configured') {
    return {
      title: 'No indexed data yet',
      body: 'Transactions will appear after analytics indexing starts for this network.',
    };
  }
  if (status === 'partial' || status === 'indexing') {
    return {
      title: 'Backfill in progress',
      body: 'No transactions are available for this page yet while historical activity is still being indexed.',
    };
  }
  return {
    title: 'No activity in selected window',
    body: 'Try a wider time filter or refresh after the next indexer run.',
  };
}

function paginationPages(totalPages: number, currentPage: number): number[] {
  const start = Math.max(1, currentPage - 2);
  const end = Math.min(totalPages, start + 4);
  const adjustedStart = Math.max(1, end - 4);
  return Array.from(
    { length: end - adjustedStart + 1 },
    (_, index) => adjustedStart + index,
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
