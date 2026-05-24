import { Copy, ExternalLink } from 'lucide-react';
import type { ShardRow } from '../solana/fetchProtocolStats';
import { explorerUrl, formatLamportsShort, shortenAddress } from '../solana/format';
import type { ClusterId } from '../solana/constants';

export function ShardTable({
  cluster,
  shards,
}: {
  cluster: ClusterId;
  shards: ShardRow[];
}) {
  return (
    <section className="panel" aria-label="Treasury shards">
      <div className="panelHeader">
        <div>
          <p className="eyebrow">Treasury Shards</p>
          <h2>Collectible fee balances</h2>
        </div>
      </div>
      <div className="tableWrap">
        <table>
          <thead>
            <tr>
              <th>Shard</th>
              <th>PDA</th>
              <th>Balance Including Rent</th>
              <th>Collectible</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {shards.map((shard) => (
              <tr key={shard.address}>
                <td>{shard.shardId}</td>
                <td>
                  <AddressActions cluster={cluster} address={shard.address} />
                </td>
                <td>{formatLamportsShort(shard.balanceLamports)}</td>
                <td>{formatLamportsShort(shard.collectibleLamports)}</td>
                <td>
                  <span className={shard.skippedReason ? 'warningText' : 'mutedText'}>
                    {shard.skippedReason ?? 'Ready'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function AddressActions({
  cluster,
  address,
}: {
  cluster: ClusterId;
  address: string;
}) {
  return (
    <div className="addressCell">
      <span title={address}>{shortenAddress(address)}</span>
      <button
        type="button"
        className="miniIconButton"
        onClick={() => void navigator.clipboard.writeText(address)}
        aria-label="Copy address"
        title="Copy address"
      >
        <Copy size={13} />
      </button>
      <a
        className="miniIconButton"
        href={explorerUrl(address, cluster)}
        target="_blank"
        rel="noreferrer"
        aria-label="Open in Explorer"
        title="Open in Explorer"
      >
        <ExternalLink size={13} />
      </a>
    </div>
  );
}

