import type { Cluster } from '../types/dashboard';

const CLUSTER_OPTIONS: Array<{ id: Cluster; label: string }> = [
  { id: 'mainnet', label: 'Mainnet' },
  { id: 'devnet', label: 'Devnet' },
];

export function ClusterSelector({ cluster, onChange }: { cluster: Cluster; onChange: (cluster: Cluster) => void }) {
  return (
    <div className="segmented" role="radiogroup" aria-label="Cluster">
      {CLUSTER_OPTIONS.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={cluster === option.id}
          className={cluster === option.id ? 'active' : undefined}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
