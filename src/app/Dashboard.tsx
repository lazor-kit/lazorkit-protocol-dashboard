import type { DashboardPayload } from '../types/dashboard';
import { ActivityCharts } from '../components/ActivityCharts';
import { BinaryPanel } from '../components/BinaryPanel';
import { DeveloperDetails } from '../components/DeveloperDetails';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { FreshnessBanner } from '../components/FreshnessBanner';
import { LatestTransactionsTable } from '../components/LatestTransactionsTable';
import { MigrationPanel } from '../components/MigrationPanel';
import { OverviewKpis } from '../components/OverviewKpis';
import { ProgramCards } from '../components/ProgramCards';
import { ProgramDetail } from '../components/ProgramDetail';
import { isDeployed, notDeployedCopy, visiblePrograms, windowLabel } from './selectors';
import type { VersionFilter } from './urlState';
import type { DashboardView } from './view';

function versionText(version: VersionFilter): string {
  return version === 'all' ? 'all protocol versions' : `protocol v${version}`;
}

function DataSections({ payload, version, now, expandAll }: { payload: DashboardPayload; version: VersionFilter; now: number; expandAll: boolean }) {
  const inView = visiblePrograms(payload, version);
  const anyDeployed = inView.some(isDeployed);
  const cluster = payload.cluster === 'mainnet' ? 'Mainnet' : 'Devnet';
  return (
    <>
      <h2 className="sectionTitle">
        Overview <span>· {cluster} · {versionText(version)} · {windowLabel(payload.window)}</span>
      </h2>
      {anyDeployed ? (
        <OverviewKpis payload={payload} version={version} now={now} />
      ) : (
        <EmptyState
          title={`Protocol v${version} is not deployed on ${payload.cluster} yet`}
          body={inView[0] ? notDeployedCopy(inView[0], payload.binaries) : 'No program of this version is tracked on this cluster.'}
        />
      )}
      <ProgramCards payload={payload} version={version} now={now} />
      {anyDeployed ? (
        <>
          <h2 className="sectionTitle">Activity over time</h2>
          <ActivityCharts payload={payload} version={version} />
          <ProgramDetail key={`${payload.cluster}-${version}`} payload={payload} version={version} now={now} />
        </>
      ) : null}
      <BinaryPanel payload={payload} now={now} expandAll={expandAll} />
      <MigrationPanel payload={payload} />
      {anyDeployed ? (
        <LatestTransactionsTable key={`${payload.cluster}-${version}`} rows={payload.latest} cluster={payload.cluster} version={version} now={now} />
      ) : null}
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
  version,
  now,
  expandAll = false,
  onRetry,
}: {
  view: DashboardView;
  version: VersionFilter;
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
          body="This version of the dashboard reads a new set of tables. They are created by one additive migration (supabase/migrations/20261002000100_lk_event_log.sql); once it is applied and the indexer has run, protocol v1 and v2 figures appear here. The current production data is not touched."
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
      <DataSections payload={view.payload} version={version} now={now} expandAll={expandAll} />
    </>
  );
}
