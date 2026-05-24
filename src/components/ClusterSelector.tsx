import { CLUSTERS, type ClusterId } from '../solana/constants';

const DASHBOARD_CLUSTERS: ClusterId[] = ['mainnet', 'devnet'];

export function ClusterSelector({
  cluster,
  onChange,
}: {
  cluster: ClusterId;
  onChange: (cluster: ClusterId) => void;
}) {
  return (
    <div className="clusterControl" role="radiogroup" aria-label="Cluster">
      {DASHBOARD_CLUSTERS.map((id) => (
        <button
          key={id}
          type="button"
          className={cluster === id ? 'active' : undefined}
          onClick={() => onChange(id)}
        >
          {CLUSTERS[id].label}
        </button>
      ))}
    </div>
  );
}
