// TEMPORARY adapter (backend step of the v1+v2 rebuild): the API now returns the v2 payload
// (src/types/dashboard.ts). This maps it onto the old DashboardStats shape so the current UI keeps compiling and
// rendering until the new UI replaces it. Delete together with src/solana/dashboardTypes.ts.

import type { DashboardPayload, Kpis, ProgramView } from '../types/dashboard.js';
import { INSTRUCTION_NAMES } from '../types/protocol.js';
import type { DashboardStats, DashboardWindow, KpiValue, LatestTransaction, LazorKitMethod } from './dashboardTypes.js';
import type { ProtocolStats } from './protocolStatsTypes.js';
import type { ClusterId } from './shared.js';

export async function fetchDashboardStats(
  cluster: ClusterId,
  window: DashboardWindow,
  _txPage = 1,
  txLimit: 10 | 15 | 50 = 10,
): Promise<DashboardStats> {
  if (cluster === 'localnet') throw new Error('Localnet is not indexed by the dashboard backend');
  const params = new URLSearchParams({ cluster, window });
  const response = await fetch(`/api/dashboard?${params.toString()}`, { headers: { accept: 'application/json' } });
  const payload = (await response.json().catch(() => null)) as DashboardPayload | { error?: string } | null;
  if (!response.ok || !payload || !('freshness' in payload)) {
    const message =
      payload && 'freshness' in payload
        ? payload.freshness.reasons[0]?.detail
        : (payload as { error?: string } | null)?.error;
    throw new Error(message ?? `Unable to load dashboard (${response.status})`);
  }
  return adaptPayload(payload as DashboardPayload, txLimit);
}

function kpiValue(current: number, previous: number | null): KpiValue {
  return {
    value: current,
    previousValue: previous ?? 0,
    percentChange: previous === null || previous === 0 ? null : ((current - previous) / previous) * 100,
  };
}

function methodOf(kinds: number[]): LazorKitMethod {
  const name = INSTRUCTION_NAMES[kinds[0] ?? 255] ?? 'Execute';
  return (name === 'CreateWallet' || name === 'ExecuteDeferred' ? name : 'Execute') as LazorKitMethod;
}

function protocolStatsOf(payload: DashboardPayload): ProtocolStats | null {
  const program: ProgramView | undefined =
    payload.programs.find((p) => p.version === 1 && p.state) ?? payload.programs.find((p) => p.state);
  if (!program?.state) return null;
  const state = program.state;
  const rent = BigInt(state.rentMinimum8);
  return {
    cluster: payload.cluster,
    programId: program.programId,
    protocolConfigAddress: state.config?.address ?? '',
    slot: program.stateSlot ?? state.slot,
    fetchedAt: program.stateFetchedAt ?? payload.generatedAt,
    cache: { hit: false, ttlSeconds: 300 },
    initialized: state.config !== null,
    config: state.config
      ? {
          discriminator: program.version === 1 ? 5 : 0x25,
          version: 1,
          bump: 0,
          enabled: state.config.enabled,
          numShards: state.config.numShards,
          admin: state.config.admin,
          treasury: state.config.treasury,
          creationFeeLamports: state.config.creationFee,
          executionFeeLamports: state.config.executionFee,
        }
      : null,
    walletAccountCount: state.wallets,
    feeRecords: (program.stateDetail?.feeRecords ?? state.feeRecords.top).map((record) => ({
      address: record.address,
      discriminator: program.version === 1 ? 6 : 0x26,
      bump: 0,
      version: 1,
      totalFeesPaidLamports: record.totalFeesPaid,
      txCount: record.txCount,
      walletCount: record.walletCount,
      registeredAt: String(record.registeredSlot),
    })),
    feeTotals: {
      recordCount: state.feeRecords.count,
      lifetimeFeesLamports: state.feeRecords.totalFeesPaid,
      txCount: state.feeRecords.txCount,
      walletCount: state.feeRecords.walletCount,
      feePayingEvents: state.feeRecords.txCount + state.feeRecords.walletCount,
    },
    shards: (program.stateDetail?.shards ?? []).map((shard) => {
      const balance = BigInt(shard.lamports);
      return {
        shardId: shard.id,
        address: shard.address,
        balanceLamports: shard.lamports,
        collectibleLamports: (balance > rent ? balance - rent : 0n).toString(),
      };
    }),
    collectibleFeesLamports: state.treasury.withdrawableNow,
    shardBalancesLamports: state.treasury.lamports,
    skippedAccounts: state.unknownAccounts ?? 0,
  };
}

export function adaptPayload(payload: DashboardPayload, txLimit: 10 | 15 | 50 = 10): DashboardStats {
  const current: Kpis | undefined = payload.kpis.cluster?.current;
  const previous: Kpis | null = payload.kpis.cluster?.previous ?? null;
  const setupRequired = payload.freshness.state === 'setup_required';
  const live = payload.programs.filter((p) => p.deployment.status === 'live');
  const backfillComplete = live.length > 0 && live.every((p) => p.sync.backfillComplete);
  const protocolStats = protocolStatsOf(payload);
  const latest: LatestTransaction[] = payload.latest.map((row) => ({
    signature: row.signature,
    blockTime: row.blockTime,
    slot: row.slot,
    feePayer: row.payer ?? '',
    walletPda: row.wallet ?? '',
    method: methodOf(row.kinds),
    status: row.ok ? 'success' : 'failed',
    feeLamports: row.feeLamports,
  }));
  const clusterSeries = payload.series.filter((point) => point.scope === 'cluster');
  const firstRun = live.map((p) => p.sync.lastRunStatus).find((s) => s === 'failed') ?? (live[0]?.sync.lastRunStatus ?? 'idle');
  return {
    cluster: payload.cluster,
    window: payload.window,
    generatedAt: payload.generatedAt,
    setupRequired,
    protocolStats,
    health: {
      protocolStatus: protocolStats?.config ? (protocolStats.config.enabled ? 'enabled' : 'paused') : 'not-initialized',
      analyticsStatus: setupRequired
        ? 'not_configured'
        : payload.freshness.state === 'live'
          ? 'fresh'
          : payload.freshness.state === 'catching_up'
            ? 'indexing'
            : payload.freshness.state === 'stale' || payload.freshness.state === 'delayed'
              ? 'stale'
              : 'error',
      dataCoverageLabel: payload.freshness.completeThrough
        ? `Complete through ${payload.freshness.completeThrough}`
        : 'Building history',
      isBackfilling: !backfillComplete,
      backfillComplete,
      oldestIndexedAt: live.map((p) => p.sync.firstActivityAt).filter(Boolean).sort()[0] ?? null,
      newestIndexedAt: payload.freshness.completeThrough,
      lastRunStatus: firstRun === 'failed' ? 'failed' : firstRun === 'lagging' ? 'partial' : firstRun === 'ok' ? 'success' : 'idle',
      lastRunError: live.map((p) => p.sync.lastError).find(Boolean) ?? null,
      lastRunWarningsCount: 0,
      lastSuccessfulRunAt: payload.freshness.lastWorkerRunAt,
      lastIndexedSlot: null,
      lastIndexedAt: payload.freshness.lastWorkerRunAt,
      cacheHit: false,
      cacheTtlSeconds: 300,
    },
    kpis: {
      totalTransactions: kpiValue(current?.txs ?? 0, previous?.txs ?? null),
      uniqueWallets: kpiValue(
        payload.window === 'all' ? live.reduce((sum, p) => sum + (p.state?.wallets ?? 0), 0) : current?.walletsCreated ?? 0,
        payload.window === 'all' ? null : previous?.walletsCreated ?? null,
      ),
      totalFeesLamports: {
        value: current?.feeLamports ?? '0',
        previousValue: previous?.feeLamports ?? '0',
        percentChange: null,
      },
      successRate: kpiValue(
        current && current.txs > 0 ? (current.txsOk / current.txs) * 100 : 0,
        previous && previous.txs > 0 ? (previous.txsOk / previous.txs) * 100 : null,
      ),
    },
    series: clusterSeries.map((point) => ({
      bucket: point.bucket,
      txCount: point.txs,
      uniqueWallets: point.activeWallets,
      createWalletCount: point.walletsCreated,
      feesLamports: point.feeLamports,
      feeEventCount: point.feeEvents,
    })),
    latestTransactions: latest,
    latestTransactionsPagination: {
      page: 1,
      limit: txLimit,
      total: latest.length,
      totalPages: Math.max(1, Math.ceil(latest.length / txLimit)),
      hasPreviousPage: false,
      hasNextPage: latest.length > txLimit,
    },
    networkComparison: { mainnetTxCount: 0, devnetTxCount: 0 },
  };
}
