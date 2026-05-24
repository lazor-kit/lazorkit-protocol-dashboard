import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ChevronDown,
  CircleDollarSign,
  Coins,
  Copy,
  Database,
  ExternalLink,
  Percent,
  RefreshCw,
  ShieldCheck,
  Wallet,
} from 'lucide-react';
import { AppShell } from '../components/AppShell';
import { ChartPanel } from '../components/ChartPanel';
import { ClusterSelector } from '../components/ClusterSelector';
import { DataNotes } from '../components/DataNotes';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { FeeRecordTable } from '../components/FeeRecordTable';
import { KpiCard } from '../components/KpiCard';
import { LatestTransactionsTable } from '../components/LatestTransactionsTable';
import { MetricCard } from '../components/MetricCard';
import { NetworkComparison } from '../components/NetworkComparison';
import { ProtocolStatus } from '../components/ProtocolStatus';
import { ShardTable } from '../components/ShardTable';
import { TimeWindowSelector } from '../components/TimeWindowSelector';
import { CLUSTERS, DEFAULT_CLUSTER, type ClusterId } from '../solana/constants';
import {
  type DashboardStats,
  type DashboardWindow,
} from '../solana/dashboardTypes';
import { fetchDashboardStats } from '../solana/fetchDashboardStats';
import type { ProtocolStats } from '../solana/fetchProtocolStats';
import {
  formatDateTime,
  formatInteger,
  formatLamportsShort,
  explorerUrl,
  shortenAddress,
} from '../solana/format';

export function App() {
  const [cluster, setCluster] = useState<ClusterId>(DEFAULT_CLUSTER);
  const [window, setWindow] = useState<DashboardWindow>('all');
  const [txPage, setTxPage] = useState(1);
  const [dashboardStats, setDashboardStats] = useState<DashboardStats | null>(null);
  const [stats, setStats] = useState<ProtocolStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const loadStats = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const nextDashboardStats = await fetchDashboardStats(cluster, window, txPage, 10);
      setDashboardStats(nextDashboardStats);
      setStats(nextDashboardStats.protocolStats);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load protocol stats');
    } finally {
      setIsLoading(false);
    }
  }, [cluster, window, txPage]);

  const handleClusterChange = useCallback((nextCluster: ClusterId) => {
    setCluster(nextCluster);
    setTxPage(1);
  }, []);

  const handleWindowChange = useCallback((nextWindow: DashboardWindow) => {
    setWindow(nextWindow);
    setTxPage(1);
  }, []);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  const status = useMemo(() => {
    if (!stats?.initialized) return 'not-initialized';
    return stats.config?.enabled ? 'enabled' : 'disabled';
  }, [stats]);
  const kpiDetail =
    dashboardStats === null
      ? ''
      : buildKpiDetail(dashboardStats, window);
  const showKpiTrend =
    window !== 'all' &&
    dashboardStats?.health.analyticsStatus !== 'empty' &&
    dashboardStats?.health.analyticsStatus !== 'not_configured' &&
    dashboardStats?.health.analyticsStatus !== 'partial' &&
    dashboardStats?.health.analyticsStatus !== 'indexing';
  const shouldMaskKpis =
    !isLoading &&
    (dashboardStats?.health.analyticsStatus === 'empty' ||
      dashboardStats?.health.analyticsStatus === 'not_configured');
  const shouldShowActivitySections = Boolean(dashboardStats && !shouldMaskKpis);

  return (
    <AppShell>
      {error ? (
        <ErrorState message={error} onRetry={() => void loadStats()} />
      ) : (
        <>
          <section className="publicHeader" aria-label="Dashboard overview">
            <div className="brandHeader">
              <img src="/lazorkit-logo.png" alt="LazorKit" className="brandLogo" />
              <div>
                <h1>LazorKit Dashboard</h1>
                <p>
                  Last updated:{' '}
                  {formatLastUpdated(dashboardStats?.generatedAt ?? stats?.fetchedAt)}
                  {' · '}
                  Status:{' '}
                  <span className="headerStatus">
                    ● {formatProtocolStatus(dashboardStats?.health.protocolStatus)}
                  </span>
                </p>
              </div>
            </div>
            <div className="publicControls">
              <ClusterSelector cluster={cluster} onChange={handleClusterChange} />
              <TimeWindowSelector window={window} onChange={handleWindowChange} />
              <button
                className="iconButton refreshButton"
                type="button"
                onClick={() => void loadStats()}
                disabled={isLoading}
                aria-label="Refresh dashboard"
                title="Refresh dashboard"
              >
                <RefreshCw size={16} className={isLoading ? 'spin' : undefined} />
              </button>
            </div>
          </section>

          {dashboardStats?.health.analyticsStatus === 'error' &&
          !shouldShowActivitySections ? (
            <EmptyState
              title="Activity data is temporarily unavailable"
              body="Live protocol metrics are still available below. Activity charts will return automatically when the next data refresh completes."
            />
          ) : dashboardStats?.health.analyticsStatus === 'empty' ? (
            <EmptyState
              title="Preparing activity data"
              body="Live protocol metrics are available below. Traffic, fee, and transaction views will appear as soon as activity data is ready."
            />
          ) : null}

          {dashboardStats?.setupRequired ? (
            <EmptyState
              title="Dashboard data is being prepared"
              body="Live protocol metrics are available below. Activity charts and transactions will appear as soon as data is ready."
            />
          ) : null}

          <section className="metricsGrid kpiGrid" aria-label="Dashboard KPIs">
            <KpiCard
              label="Total Transactions"
              value={
                isLoading || !dashboardStats
                  ? 'Loading'
                  : shouldMaskKpis
                    ? '--'
                  : formatInteger(dashboardStats.kpis.totalTransactions.value)
              }
              detail={kpiDetail}
              percentChange={dashboardStats?.kpis.totalTransactions.percentChange ?? 0}
              icon={Activity}
              isLoading={isLoading}
              showTrend={showKpiTrend}
            />
            <KpiCard
              label="Wallet Accounts"
              value={
                isLoading || !dashboardStats
                  ? 'Loading'
                  : shouldMaskKpis
                    ? '--'
                  : formatInteger(dashboardStats.kpis.uniqueWallets.value)
              }
              detail={kpiDetail}
              percentChange={dashboardStats?.kpis.uniqueWallets.percentChange ?? 0}
              icon={Wallet}
              isLoading={isLoading}
              showTrend={showKpiTrend}
            />
            <KpiCard
              label="Total Fees"
              value={
                isLoading || !dashboardStats
                  ? 'Loading'
                  : shouldMaskKpis
                    ? '--'
                  : formatLamportsShort(
                      String(dashboardStats.kpis.totalFeesLamports.value),
                    )
              }
              detail={kpiDetail}
              percentChange={dashboardStats?.kpis.totalFeesLamports.percentChange ?? 0}
              icon={CircleDollarSign}
              isLoading={isLoading}
              showTrend={showKpiTrend}
            />
            <KpiCard
              label="Success Rate"
              value={
                isLoading || !dashboardStats
                  ? 'Loading'
                  : shouldMaskKpis
                    ? '--'
                  : formatPercent(dashboardStats.kpis.successRate.value)
              }
              detail={kpiDetail}
              percentChange={dashboardStats?.kpis.successRate.percentChange ?? 0}
              icon={Percent}
              isLoading={isLoading}
              showTrend={showKpiTrend}
            />
          </section>

          {dashboardStats && shouldShowActivitySections ? (
            <>
              <section className="chartsGrid" aria-label="Analytics charts">
                <ChartPanel
                  title="Tx over time"
                  metric="txCount"
                  window={window}
                  series={dashboardStats.series}
                />
                <ChartPanel
                  title="Wallets created"
                  metric="createWalletCount"
                  window={window}
                  series={dashboardStats.series}
                />
                <ChartPanel
                  title="Fees over time"
                  metric="feesLamports"
                  window={window}
                  series={dashboardStats.series}
                />
              </section>
              <LatestTransactionsTable
                cluster={cluster}
                rows={dashboardStats.latestTransactions}
                pagination={dashboardStats.latestTransactionsPagination}
                analyticsStatus={dashboardStats.health.analyticsStatus}
                onPageChange={setTxPage}
              />
            </>
          ) : null}

          {!isLoading && stats && !stats.initialized ? (
            <EmptyState
              title="Protocol not initialized"
              body="No ProtocolConfig account was found for this program on the selected cluster."
            />
          ) : null}

          {stats?.initialized ? (
            <details className="technicalDetails">
              <summary>
                <div className="technicalSummaryMain">
                  <Database size={18} />
                  <span>
                    Technical protocol details
                    <small>Protocol config, treasury shards, FeeRecord accounts</small>
                  </span>
                </div>
                <div className="technicalSummaryAction">
                  <span className="showLabel">Show details</span>
                  <span className="hideLabel">Hide details</span>
                  <ChevronDown size={18} />
                </div>
              </summary>
              {dashboardStats && shouldShowActivitySections ? (
                <NetworkComparison comparison={dashboardStats.networkComparison} />
              ) : null}
              <section className="metricsGrid secondaryMetricsGrid" aria-label="Protocol metrics">
                <ProtocolStatus status={status} isLoading={isLoading} />
                <MetricCard
                  label="Wallet Accounts"
                  value={
                    isLoading || !stats
                      ? 'Loading'
                      : formatInteger(stats.walletAccountCount)
                  }
                  detail="Current wallet PDAs"
                  icon={Wallet}
                  isLoading={isLoading}
                />
                <MetricCard
                  label="Lifetime Fees Recorded"
                  value={
                    isLoading || !stats
                      ? 'Loading'
                      : formatLamportsShort(stats.feeTotals.lifetimeFeesLamports)
                  }
                  detail="Cumulative, not treasury balance"
                  icon={CircleDollarSign}
                  isLoading={isLoading}
                />
                <MetricCard
                  label="Currently Collectible Fees"
                  value={
                    isLoading || !stats
                      ? 'Loading'
                      : formatLamportsShort(stats.collectibleFeesLamports)
                  }
                  detail="Shard balance minus rent"
                  icon={Coins}
                  isLoading={isLoading}
                />
                <MetricCard
                  label="Fee Payer Records"
                  value={
                    isLoading || !stats
                      ? 'Loading'
                      : formatInteger(stats.feeTotals.recordCount)
                  }
                  detail="FeeRecord account count"
                  icon={Database}
                  isLoading={isLoading}
                />
                <MetricCard
                  label="Fee-Paying Events"
                  value={
                    isLoading || !stats
                      ? 'Loading'
                      : formatInteger(stats.feeTotals.feePayingEvents)
                  }
                  detail="All-time wallets + txns"
                  icon={ShieldCheck}
                  isLoading={isLoading}
                />
              </section>
              <section className="panel" aria-label="Protocol configuration">
                <div className="panelHeader">
                  <div>
                    <p className="eyebrow">Protocol Config</p>
                    <h2>Current fee surface</h2>
                  </div>
                  {stats.skippedAccounts > 0 ? (
                    <span className="warningPill">
                      {formatInteger(stats.skippedAccounts)} skipped account
                      {stats.skippedAccounts === 1 ? '' : 's'}
                    </span>
                  ) : null}
                </div>
                <div className="configGrid">
                  <AddressConfigItem
                    cluster={cluster}
                    label="Program ID"
                    value={stats.programId}
                  />
                  <AddressConfigItem
                    cluster={cluster}
                    label="Protocol Config"
                    value={stats.protocolConfigAddress}
                  />
                  <AddressConfigItem
                    cluster={cluster}
                    label="Admin"
                    value={stats.config!.admin}
                  />
                  <AddressConfigItem
                    cluster={cluster}
                    label="Treasury"
                    value={stats.config!.treasury}
                  />
                  <ConfigItem label="Cluster" value={CLUSTERS[cluster].label} />
                  <ConfigItem
                    label="Creation Fee"
                    value={formatLamportsShort(stats.config!.creationFeeLamports)}
                  />
                  <ConfigItem
                    label="Execution Fee"
                    value={formatLamportsShort(stats.config!.executionFeeLamports)}
                  />
                  <ConfigItem
                    label="Shard Count"
                    value={formatInteger(stats.config!.numShards)}
                  />
                  <ConfigItem
                    label="Last Refresh"
                    value={formatDateTime(stats.fetchedAt)}
                  />
                  <ConfigItem
                    label="Shard Balances Including Rent"
                    value={formatLamportsShort(stats.shardBalancesLamports)}
                  />
                </div>
              </section>

              <DataNotes />
              <ShardTable cluster={cluster} shards={stats.shards} />
              <FeeRecordTable cluster={cluster} rows={stats.feeRecords} />
            </details>
          ) : null}
        </>
      )}
    </AppShell>
  );
}

function formatPercent(value: number | string): string {
  const numeric = typeof value === 'string' ? Number(value) : value;
  return `${new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 1,
  }).format(numeric * 100)}%`;
}

function ConfigItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="configItem">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatLastUpdated(value: string | undefined): string {
  if (!value) return 'Loading';
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(value));
}

function formatProtocolStatus(
  status: DashboardStats['health']['protocolStatus'] | undefined,
): string {
  if (status === 'enabled') return 'Enabled';
  if (status === 'paused') return 'Paused';
  if (status === 'not-initialized') return 'Not initialized';
  return 'Loading';
}

function buildKpiDetail(
  stats: DashboardStats,
  window: DashboardWindow,
): string {
  if (
    stats.health.analyticsStatus === 'empty' ||
    stats.health.analyticsStatus === 'not_configured'
  ) {
    return 'Preparing data';
  }
  if (stats.health.analyticsStatus === 'error' || stats.health.analyticsStatus === 'stale') {
    return 'Latest available data';
  }
  if (stats.health.analyticsStatus === 'partial' || stats.health.analyticsStatus === 'indexing') {
    return window === 'all' ? 'Activity to date' : 'Latest available data';
  }
  return window === 'all' ? 'Activity to date' : `vs previous ${window}`;
}

function AddressConfigItem({
  cluster,
  label,
  value,
}: {
  cluster: ClusterId;
  label: string;
  value: string;
}) {
  return (
    <div className="configItem">
      <span>{label}</span>
      <strong className="addressConfigValue" title={value}>
        {shortenAddress(value, 5)}
        <button
          type="button"
          className="miniIconButton"
          onClick={() => void navigator.clipboard.writeText(value)}
          aria-label={`Copy ${label}`}
          title={`Copy ${label}`}
        >
          <Copy size={13} />
        </button>
        <a
          className="miniIconButton"
          href={explorerUrl(value, cluster)}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open ${label} in Explorer`}
          title={`Open ${label} in Explorer`}
        >
          <ExternalLink size={13} />
        </a>
      </strong>
    </div>
  );
}
