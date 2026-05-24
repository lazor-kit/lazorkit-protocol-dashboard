import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
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
import { AnalyticsHealthBar } from '../components/AnalyticsHealthBar';
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
import { StatusBar } from '../components/StatusBar';
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
  const [window, setWindow] = useState<DashboardWindow>('24h');
  const [dashboardStats, setDashboardStats] = useState<DashboardStats | null>(null);
  const [stats, setStats] = useState<ProtocolStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const loadStats = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const nextDashboardStats = await fetchDashboardStats(cluster, window);
      setDashboardStats(nextDashboardStats);
      setStats(nextDashboardStats.protocolStats);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load protocol stats');
    } finally {
      setIsLoading(false);
    }
  }, [cluster, window]);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  const status = useMemo(() => {
    if (!stats?.initialized) return 'not-initialized';
    return stats.config?.enabled ? 'enabled' : 'disabled';
  }, [stats]);

  return (
    <AppShell
      actions={
        <>
          <ClusterSelector cluster={cluster} onChange={setCluster} />
          <TimeWindowSelector window={window} onChange={setWindow} />
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
        </>
      }
    >
      <StatusBar
        cluster={cluster}
        clusterLabel={CLUSTERS[cluster].label}
        programId={stats?.programId ?? CLUSTERS[cluster].programAddress}
        slot={stats?.slot}
        fetchedAt={stats?.fetchedAt}
      />

      {error ? (
        <ErrorState message={error} onRetry={() => void loadStats()} />
      ) : (
        <>
          <AnalyticsHealthBar stats={dashboardStats} />

          {dashboardStats?.setupRequired ? (
            <EmptyState
              title="Analytics setup required"
              body="Set Supabase server environment variables and run the indexer to populate time-based metrics. Protocol snapshot data remains available below."
            />
          ) : null}

          <section className="metricsGrid kpiGrid" aria-label="Dashboard KPIs">
            <KpiCard
              label="Total Transactions"
              value={
                isLoading || !dashboardStats
                  ? 'Loading'
                  : formatInteger(dashboardStats.kpis.totalTransactions.value)
              }
              detail={`vs previous ${window}`}
              percentChange={dashboardStats?.kpis.totalTransactions.percentChange ?? 0}
              icon={Activity}
              isLoading={isLoading}
            />
            <KpiCard
              label="Unique Wallets"
              value={
                isLoading || !dashboardStats
                  ? 'Loading'
                  : formatInteger(dashboardStats.kpis.uniqueWallets.value)
              }
              detail={`vs previous ${window}`}
              percentChange={dashboardStats?.kpis.uniqueWallets.percentChange ?? 0}
              icon={Wallet}
              isLoading={isLoading}
            />
            <KpiCard
              label="Total Fees"
              value={
                isLoading || !dashboardStats
                  ? 'Loading'
                  : formatLamportsShort(
                      String(dashboardStats.kpis.totalFeesLamports.value),
                    )
              }
              detail={`vs previous ${window}`}
              percentChange={dashboardStats?.kpis.totalFeesLamports.percentChange ?? 0}
              icon={CircleDollarSign}
              isLoading={isLoading}
            />
            <KpiCard
              label="Success Rate"
              value={
                isLoading || !dashboardStats
                  ? 'Loading'
                  : formatPercent(dashboardStats.kpis.successRate.value)
              }
              detail={`vs previous ${window}`}
              percentChange={dashboardStats?.kpis.successRate.percentChange ?? 0}
              icon={Percent}
              isLoading={isLoading}
            />
          </section>

          {dashboardStats ? (
            <>
              <section className="chartsGrid" aria-label="Analytics charts">
                <ChartPanel
                  title="Transactions over time"
                  metric="txCount"
                  series={dashboardStats.series}
                />
                <ChartPanel
                  title="Unique wallets over time"
                  metric="uniqueWallets"
                  series={dashboardStats.series}
                />
                <ChartPanel
                  title="Fees over time"
                  metric="feesLamports"
                  series={dashboardStats.series}
                />
              </section>
              <NetworkComparison comparison={dashboardStats.networkComparison} />
              <LatestTransactionsTable
                cluster={cluster}
                rows={dashboardStats.latestTransactions}
              />
            </>
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

          {!isLoading && stats && !stats.initialized ? (
            <EmptyState
              title="Protocol not initialized"
              body="No ProtocolConfig account was found for this program on the selected cluster."
            />
          ) : null}

          {stats?.initialized ? (
            <>
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
            </>
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
