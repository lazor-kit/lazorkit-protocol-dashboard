import type { Cluster, FeeRecordView } from '../types/dashboard';
import { exactLamports, formatInteger, formatLamports } from '../lib/format';
import { AddressLink } from './ui';

/** FeeRecord accounts (the record PDA; the payer key is a seed and is not stored in the account). */
export function FeeRecordTable({
  cluster,
  rows,
  total,
  lowerBound,
}: {
  cluster: Cluster;
  rows: FeeRecordView[];
  total: number;
  lowerBound: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <details className="subTable">
      <summary>
        Fee records ({rows.length < total ? `top ${rows.length} of ${formatInteger(total)}` : formatInteger(total)})
        {lowerBound ? ' · registered payers only' : ''}
      </summary>
      <div className="tableWrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Record</th>
              <th scope="col" className="num">Fees paid</th>
              <th scope="col" className="num">Transactions</th>
              <th scope="col" className="num">Wallets</th>
              <th scope="col" className="num">Registered at slot</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.address}>
                <td>
                  <AddressLink address={row.address} cluster={cluster} label="fee record" copy />
                </td>
                <td className="num" title={exactLamports(row.totalFeesPaid)}>
                  {formatLamports(row.totalFeesPaid)}
                </td>
                <td className="num">{formatInteger(row.txCount)}</td>
                <td className="num">{formatInteger(row.walletCount)}</td>
                <td className="num">{formatInteger(row.registeredSlot)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
