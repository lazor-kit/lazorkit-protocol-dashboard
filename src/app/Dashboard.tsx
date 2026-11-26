import type { DashboardPayload } from '../types/dashboard';
import { ActivityCharts } from '../components/ActivityCharts';
import { BinaryPanel } from '../components/BinaryPanel';
import { DeveloperDetails } from '../components/DeveloperDetails';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { FreshnessBanner } from '../components/FreshnessBanner';
import { LatestTransactionsTable } from '../components/LatestTransactionsTable';
import { OverviewKpis } from '../components/OverviewKpis';
import { ProgramCards } from '../components/ProgramCards';
import { ProgramDetail } from '../components/ProgramDetail';
import { deploymentNote, isDeployed, visiblePrograms, windowLabel } from './selectors';
import type { DashboardView } from './view';

function DataSections({ payload, now, expandAll }: { payload: DashboardPayload; now: number; expandAll: boolean }) {
  const version = '1';
  const inView = visiblePrograms(payload, version);
  const anyDeployed = inView.some(isDeployed);
  const cluster = payload.cluster === 'mainnet' ? 'Mainnet' : 'Devnet';
  return (
    <>
      <h2 className="sectionTitle">
        Overview <span>· {cluster} · {windowLabel(payload.window)}</span>
      </h2>
      {anyDeployed ? (
        <OverviewKpis payload={payload} now={now} />
      ) : inView.length > 0 && inView.every((program) => program.deployment.status === 'unknown') ? (
        <EmptyState
          title="Waiting for the first indexer run"
          body="Figures appear after the indexer's first run. The first run checks every program, then pages each one's history back to its deploy transaction; until that backfill completes the banner shows its progress."
        />
      ) : inView.length === 0 ? (
        <EmptyState title={`No LazorKit program is live on ${payload.cluster}`} body="Program status and history appear here once a tracked program is deployed." />
      ) : (
        <EmptyState title={`Protocol v${version} is not deployed on ${payload.cluster} yet`} body={deploymentNote(inView[0], payload.binaries)} />
      )}
      {anyDeployed ? (
        <>
          <h2 className="sectionTitle">Activity over time</h2>
          <ActivityCharts payload={payload} />
        </>
      ) : null}
      {anyDeployed ? (
        <LatestTransactionsTable
          key={`${payload.cluster}-${version}`}
          rows={payload.latest}
          programs={inView}
          cluster={payload.cluster}
          version={version}
          now={now}
        />
      ) : null}
      <details className="technicalDetails" id="on-chain-details" open={expandAll}>
        <summary>
          <div className="technicalSummaryMain">
            <span>On-chain details<small>Wallets, sessions, fees, treasury, and deployment history</small></span>
          </div>
          <span className="technicalSummaryAction">
            <span className="showLabel">Show details</span>
            <span className="hideLabel">Hide details</span>
          </span>
        </summary>
        <ProgramCards payload={payload} version={version} now={now} />
        {anyDeployed ? <ProgramDetail key={`${payload.cluster}-${version}`} payload={payload} version={version} now={now} /> : null}
        <BinaryPanel payload={payload} now={now} expandAll={expandAll} />
      </details>
      <DeveloperDetails payload={payload} now={now} open={expandAll} />
    </>
  );
}

function LoadingSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading dashboard">
      <section className="kpiGrid">
        {Array.from({ length: 6 }, (_, index) => (
          <article className="kpiCard" key={index}>
            <span className="kpiLabel skeletonText">Loading</span>
            <strong className="kpiValue skeletonText">0</strong>
          </article>
        ))}
      </section>
    </div>
  );
}

/** Everything below the header (spec §11.2 items 2-10), as a pure function of the view. */
export function Dashboard({
  view,
  now,
  expandAll = false,
  onRetry,
}: {
  view: DashboardView;
  now: number;
  expandAll?: boolean;
  onRetry?: () => void;
}) {
  if (view.kind === 'loading') return <LoadingSkeleton />;
  if (view.kind === 'error') return <ErrorState message={view.message} onRetry={onRetry} />;
  if (view.kind === 'setup_required') {
    return (
      <>
        <FreshnessBanner banner={view.banner} />
        <EmptyState
          title="Waiting for the database upgrade"
          body="Protocol v1 figures will appear once the database is configured and the first indexer run finishes."
        />
      </>
    );
  }
  if (view.kind === 'unavailable') {
    return (
      <>
        <FreshnessBanner banner={view.banner} />
        <EmptyState title="No figures to show" body="The data service did not answer and this browser has no saved copy of this view yet." />
      </>
    );
  }
  return (
    <>
      {view.banner ? <FreshnessBanner banner={view.banner} /> : null}
      <DataSections payload={view.payload} now={now} expandAll={expandAll} />
    </>
  );
}
