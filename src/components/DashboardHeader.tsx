import { ArrowUpRight, RefreshCw } from 'lucide-react';
import type { Cluster, DashboardWindow, Freshness } from '../types/dashboard';
import { FRESHNESS_LABELS, FRESHNESS_TONES } from '../app/selectors';
import { formatAge, formatUtc } from '../lib/format';
import { ClusterSelector } from './ClusterSelector';
import { ThemeToggle } from './ThemeToggle';
import { TimeWindowSelector } from './TimeWindowSelector';
import { Pill } from './ui';

export function DashboardHeader({
  cluster,
  window,
  freshness,
  loading,
  now,
  onCluster,
  onWindow,
  onRefresh,
}: {
  cluster: Cluster;
  window: DashboardWindow;
  freshness: Freshness | null;
  loading: boolean;
  now: number;
  onCluster: (cluster: Cluster) => void;
  onWindow: (window: DashboardWindow) => void;
  onRefresh: () => void;
}) {
  return (
    <header className="publicHeader">
      <div className="brandHeader">
        <img src="/brand/mark-dark.svg" alt="" className="brandLogo brandLogoDark" width={42} height={42} />
        <img src="/brand/mark-light.svg" alt="" className="brandLogo brandLogoLight" width={42} height={42} />
        <div>
          <h1>LazorKit Protocol Dashboard</h1>
          <p className="dashboardIntro">Wallet activity, transactions, and fees for LazorKit Protocol v1 on Solana.</p>
          <p className="freshnessLine">
            {freshness ? (
              <>
                <span>
                  Data complete through <strong>{freshness.completeThrough ? formatUtc(freshness.completeThrough, now) : '–'}</strong>
                </span>
                <span aria-hidden="true"> · </span>
                <span title={freshness.lastWorkerRunAt ? formatUtc(freshness.lastWorkerRunAt, now, { alwaysDate: true, seconds: true }) : undefined}>
                  indexer checked <strong>{freshness.lastWorkerRunAt ? formatAge(freshness.lastWorkerRunAt, now) : 'never'}</strong>
                </span>
                <Pill tone={FRESHNESS_TONES[freshness.state]}>{FRESHNESS_LABELS[freshness.state]}</Pill>
              </>
            ) : (
              <span className="skeletonInline">Loading data status</span>
            )}
          </p>
        </div>
      </div>
      <div className="publicControls">
        <ClusterSelector cluster={cluster} onChange={onCluster} />
        <TimeWindowSelector window={window} onChange={onWindow} />
        <div className="iconGroup">
          <button
            className="iconButton"
            type="button"
            onClick={onRefresh}
            disabled={loading}
            aria-label="Refresh dashboard"
            title="Refresh dashboard"
          >
            <RefreshCw size={16} className={loading ? 'spin' : undefined} aria-hidden="true" />
          </button>
          <ThemeToggle />
          <a className="dashboardDocsLink" href="https://docs.lazorkit.com/">
            Docs <ArrowUpRight size={14} aria-hidden="true" />
          </a>
        </div>
      </div>
    </header>
  );
}
