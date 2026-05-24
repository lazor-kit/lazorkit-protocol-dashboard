import { CLUSTERS, type ClusterId } from '../solana/constants';

export function ClusterSelector({
  cluster,
  onChange,
}: {
  cluster: ClusterId;
  onChange: (cluster: ClusterId) => void;
}) {
  return (
    <div className="clusterControl" role="radiogroup" aria-label="Cluster">
      {(Object.keys(CLUSTERS) as ClusterId[]).map((id) => (
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

