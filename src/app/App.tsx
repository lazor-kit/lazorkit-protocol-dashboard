import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ChevronDown,
  CircleDollarSign,
  Copy,
  Database,
  ExternalLink,
  Percent,
  RefreshCw,
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
import { ShardTable } from '../components/ShardTable';
import { TimeWindowSelector } from '../components/TimeWindowSelector';
import { DEFAULT_CLUSTER, type ClusterId } from '../solana/constants';
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
      const nextDashboardStats = await fetchDashboardStats(cluster, window, 1, 50);
      setDashboardStats(nextDashboardStats);
      setStats(nextDashboardStats.protocolStats);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load protocol stats');
    } finally {
      setIsLoading(false);
    }
  }, [cluster, window]);

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

  const kpiDetail =
    dashboardStats === null
      ? ''
      : buildKpiDetail(dashboardStats, window);
  const walletKpiLabel = window === 'all' ? 'Wallet Accounts' : 'Wallets Created';
  const walletKpiDetail =
    dashboardStats === null
      ? ''
      : window === 'all'
        ? 'Current total'
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
  const latestTransactionsPage = useMemo(() => {
    if (!dashboardStats) return null;
    return paginateLatestTransactions(dashboardStats, txPage, 10);
  }, [dashboardStats, txPage]);

  return (
    <AppShell>
      {error ? (
        <ErrorState message={error} onRetry={() => void loadStats()} />
      ) : (
        <>
          <section className="publicHeader" aria-label="Dashboard overview">
            <div className="heroMain">
              <div className="brandHeader">
                <img src="/lazorkit-logo.png" alt="LazorKit" className="brandLogo" />
                <div>
                  <p className="eyebrow">Public Protocol Analytics</p>
                  <h1>LazorKit Dashboard</h1>
                </div>
              </div>
              <div className="heroMetaGrid" aria-label="Protocol health summary">
                <div className="heroMetaItem">
                  <span>Protocol</span>
                  <strong>
                    <span className="statusDot" aria-hidden="true" />
                    {formatProtocolStatus(dashboardStats?.health.protocolStatus)}
                  </strong>
                </div>
                <div className="heroMetaItem">
                  <span>Network</span>
                  <strong>{cluster === 'mainnet' ? 'Mainnet' : 'Devnet'}</strong>
                </div>
                <div className="heroMetaItem">
                  <span>Coverage</span>
                  <strong>{formatHeroCoverage(dashboardStats)}</strong>
                </div>
                <div className="heroMetaItem">
                  <span>Updated</span>
                  <strong>
                    {formatLastUpdated(dashboardStats?.generatedAt ?? stats?.fetchedAt)}
                  </strong>
                </div>
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
              label={walletKpiLabel}
              value={
                isLoading || !dashboardStats
                  ? 'Loading'
                  : shouldMaskKpis
                    ? '--'
                  : formatInteger(dashboardStats.kpis.uniqueWallets.value)
              }
              detail={walletKpiDetail}
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
                  title="Transaction volume"
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
                  title="Protocol fees"
                  metric="feesLamports"
                  window={window}
                  series={dashboardStats.series}
                />
              </section>
              <LatestTransactionsTable
                cluster={cluster}
                rows={latestTransactionsPage?.rows ?? []}
                pagination={
                  latestTransactionsPage?.pagination ??
                  dashboardStats.latestTransactionsPagination
                }
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
                    Developer details
                    <small>Indexer health, raw counters, addresses, and account tables</small>
                  </span>
                </div>
                <div className="technicalSummaryAction">
                  <span className="showLabel">Show details</span>
                  <span className="hideLabel">Hide details</span>
                  <ChevronDown size={18} />
                </div>
              </summary>
              {dashboardStats ? (
                <section className="panel" aria-label="Indexer health">
                  <div className="panelHeader">
                    <div>
                      <p className="eyebrow">Worker</p>
                      <h2>Indexer health</h2>
                    </div>
                  </div>
                  <div className="configGrid">
                    <ConfigItem
                      label="Analytics Status"
                      value={formatAnalyticsStatus(dashboardStats.health.analyticsStatus)}
                    />
                    <ConfigItem
                      label="Coverage"
                      value={dashboardStats.health.dataCoverageLabel}
                    />
                    <ConfigItem
                      label="Last Successful Run"
                      value={formatOptionalDateTime(
                        dashboardStats.health.lastSuccessfulRunAt,
                      )}
                    />
                    <ConfigItem
                      label="Last Indexed Slot"
                      value={formatOptionalInteger(dashboardStats.health.lastIndexedSlot)}
                    />
                    <ConfigItem
                      label="Last Indexed At"
                      value={formatOptionalDateTime(dashboardStats.health.lastIndexedAt)}
                    />
                    <ConfigItem
                      label="Backfill Complete"
                      value={dashboardStats.health.backfillComplete ? 'Yes' : 'No'}
                    />
                    <ConfigItem
                      label="Run Status"
                      value={dashboardStats.health.lastRunStatus}
                    />
                    <ConfigItem
                      label="Warnings"
                      value={formatInteger(dashboardStats.health.lastRunWarningsCount)}
                    />
                    <ConfigItem
                      label="Last Error"
                      value={dashboardStats.health.lastRunError ?? '-'}
                    />
                    <ConfigItem
                      label="API Cache"
                      value={
                        dashboardStats.health.cacheHit
                          ? `Hit, ${dashboardStats.health.cacheTtlSeconds}s TTL`
                          : 'Miss'
                      }
                    />
                  </div>
                </section>
              ) : null}
              <section className="panel" aria-label="Protocol configuration">
                <div className="panelHeader">
                  <div>
                    <p className="eyebrow">Protocol</p>
                    <h2>Addresses and fee config</h2>
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
                    label="Snapshot Slot"
                    value={formatInteger(stats.slot)}
                  />
                </div>
              </section>

              <section className="panel" aria-label="Raw on-chain counters">
                <div className="panelHeader">
                  <div>
                    <p className="eyebrow">Raw Counters</p>
                    <h2>FeeRecord and treasury state</h2>
                  </div>
                </div>
                <div className="configGrid">
                  <ConfigItem
                    label="FeeRecord Accounts"
                    value={formatInteger(stats.feeTotals.recordCount)}
                  />
                  <ConfigItem
                    label="Wallets Recorded"
                    value={formatInteger(stats.feeTotals.walletCount)}
                  />
                  <ConfigItem
                    label="Txns Recorded"
                    value={formatInteger(stats.feeTotals.txCount)}
                  />
                  <ConfigItem
                    label="Fee-Paying Events"
                    value={formatInteger(stats.feeTotals.feePayingEvents)}
                  />
                  <ConfigItem
                    label="Lifetime Fees Recorded"
                    value={formatLamportsShort(stats.feeTotals.lifetimeFeesLamports)}
                  />
                  <ConfigItem
                    label="Collectible Fees"
                    value={formatLamportsShort(stats.collectibleFeesLamports)}
                  />
                  <ConfigItem
                    label="Shard Balances Including Rent"
                    value={formatLamportsShort(stats.shardBalancesLamports)}
                  />
                  <ConfigItem
                    label="Wallet Accounts"
                    value={formatInteger(stats.walletAccountCount)}
                  />
                  <ConfigItem
                    label="Snapshot Refresh"
                    value={formatDateTime(stats.fetchedAt)}
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

function formatHeroCoverage(stats: DashboardStats | null): string {
  if (!stats) return 'Loading';
  const oldest = stats.health.oldestIndexedAt;
  const newest = stats.health.newestIndexedAt;
  if (!oldest || !newest) return 'Preparing';

  const start = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(new Date(oldest));
  const end = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(new Date(newest));
  return `${start} - ${end}`;
}

function formatAnalyticsStatus(
  status: DashboardStats['health']['analyticsStatus'],
): string {
  if (status === 'not_configured') return 'Not configured';
  if (status === 'empty') return 'No indexed rows';
  if (status === 'indexing') return 'Running';
  if (status === 'partial') return 'Partial';
  if (status === 'fresh') return 'Fresh';
  if (status === 'stale') return 'Stale';
  return 'Error';
}

function formatOptionalDateTime(value: string | null): string {
  return value ? formatDateTime(value) : '-';
}

function formatOptionalInteger(value: number | null): string {
  return value === null ? '-' : formatInteger(value);
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
  return window === 'all' ? 'Activity to date' : `vs previous ${window}`;
}

function paginateLatestTransactions(
  stats: DashboardStats,
  page: number,
  limit: 10,
): {
  rows: DashboardStats['latestTransactions'];
  pagination: DashboardStats['latestTransactionsPagination'];
} {
  const total = stats.latestTransactions.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * limit;
  return {
    rows: stats.latestTransactions.slice(start, start + limit),
    pagination: {
      page: safePage,
      limit,
      total,
      totalPages,
      hasPreviousPage: safePage > 1,
      hasNextPage: safePage < totalPages,
    },
  };
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
