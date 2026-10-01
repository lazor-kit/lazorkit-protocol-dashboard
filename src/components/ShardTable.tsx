import type { Cluster, Lamports } from '../types/dashboard';
import { exactLamports, formatLamports, toBigInt } from '../lib/format';
import { AddressLink } from './ui';

/** Treasury shards: balance, and what is withdrawable above the rent-exempt minimum today. */
export function ShardTable({
  cluster,
  shards,
  rentMinimum,
}: {
  cluster: Cluster;
  shards: Array<{ id: number; address: string; lamports: Lamports }>;
  rentMinimum: Lamports;
}) {
  if (shards.length === 0) return null;
  const rent = toBigInt(rentMinimum);
  return (
    <details className="subTable">
      <summary>Treasury shards ({shards.length})</summary>
      <div className="tableWrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Shard</th>
              <th scope="col">Address</th>
              <th scope="col" className="num">Balance</th>
              <th scope="col" className="num">Withdrawable now</th>
            </tr>
          </thead>
          <tbody>
            {[...shards]
              .sort((a, b) => a.id - b.id)
              .map((shard) => {
                const balance = toBigInt(shard.lamports);
                const withdrawable = balance > rent ? balance - rent : 0n;
                return (
                  <tr key={shard.address}>
                    <td className="num">{shard.id}</td>
                    <td>
                      <AddressLink address={shard.address} cluster={cluster} label="shard" copy />
                    </td>
                    <td className="num" title={exactLamports(balance)}>
                      {formatLamports(balance)}
                    </td>
                    <td className="num" title={exactLamports(withdrawable)}>
                      {formatLamports(withdrawable)}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
    </details>
  );
}
