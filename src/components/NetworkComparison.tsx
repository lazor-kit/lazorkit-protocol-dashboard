import type { NetworkComparison as NetworkComparisonData } from '../solana/dashboardTypes';

export function NetworkComparison({
  comparison,
}: {
  comparison: NetworkComparisonData;
}) {
  const total = Math.max(
    1,
    comparison.mainnetTxCount + comparison.devnetTxCount,
  );
  const mainnetPct = (comparison.mainnetTxCount / total) * 100;
  const devnetPct = (comparison.devnetTxCount / total) * 100;

  return (
    <section className="networkComparison" aria-label="Network comparison">
      <div>
        <p className="eyebrow">Network Activity</p>
        <h2>Mainnet vs Devnet</h2>
      </div>
      <div className="networkBars">
        <NetworkBar
          label="Mainnet"
          value={comparison.mainnetTxCount}
          percent={mainnetPct}
        />
        <NetworkBar
          label="Devnet"
          value={comparison.devnetTxCount}
          percent={devnetPct}
        />
      </div>
    </section>
  );
}

function NetworkBar({
  label,
  value,
  percent,
}: {
  label: string;
  value: number;
  percent: number;
}) {
  return (
    <div className="networkBar">
      <div className="networkBarMeta">
        <span>{label}</span>
        <strong>{value.toLocaleString()}</strong>
      </div>
      <div className="barTrack">
        <div style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
