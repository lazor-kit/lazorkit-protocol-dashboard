import { Copy, ExternalLink } from 'lucide-react';
import type { ClusterId } from '../solana/constants';
import { explorerUrl, shortenAddress } from '../solana/format';

export function StatusBar({
  cluster,
  clusterLabel,
  programId,
  rpcUrl,
  slot,
  fetchedAt,
}: {
  cluster: ClusterId;
  clusterLabel: string;
  programId: string;
  rpcUrl: string;
  slot?: number;
  fetchedAt?: Date;
}) {
  return (
    <section className="statusBar" aria-label="Connection status">
      <Info label="Cluster" value={clusterLabel} />
      <Info
        cluster={cluster}
        label="Program"
        value={shortenAddress(programId, 5)}
        copy={programId}
      />
      <Info label="RPC" value={rpcUrl.replace(/^https?:\/\//, '')} />
      <Info label="Slot" value={slot === undefined ? 'Loading' : slot.toLocaleString()} />
      <Info
        label="Updated"
        value={fetchedAt ? fetchedAt.toLocaleTimeString() : 'Loading'}
      />
    </section>
  );
}

function Info({
  cluster,
  label,
  value,
  copy,
}: {
  cluster?: ClusterId;
  label: string;
  value: string;
  copy?: string;
}) {
  return (
    <div className="statusItem">
      <span>{label}</span>
      <strong title={copy ?? value}>{value}</strong>
      {copy ? (
        <>
          <button
            type="button"
            className="miniIconButton"
            onClick={() => void navigator.clipboard.writeText(copy)}
            aria-label={`Copy ${label}`}
            title={`Copy ${label}`}
          >
            <Copy size={13} />
          </button>
          <a
            className="miniIconButton"
            href={explorerUrl(copy, cluster ?? 'mainnet')}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${label} in Explorer`}
            title={`Open ${label} in Explorer`}
          >
            <ExternalLink size={13} />
          </a>
        </>
      ) : null}
    </div>
  );
}
