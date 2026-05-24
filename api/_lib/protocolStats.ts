import {
  Connection,
  type GetProgramAccountsFilter,
  type PublicKey,
} from '@solana/web3.js';
import {
  decodeFeeRecord,
  decodeProtocolConfig,
  decodeTreasuryShard,
} from '../../src/solana/decoders.js';
import { findProtocolConfigPda, findTreasuryShardPda } from '../../src/solana/pdas.js';
import type {
  FeeRecordRow,
  ProtocolConfigJson,
  ProtocolStats,
  ShardRow,
} from '../../src/solana/protocolStatsTypes.js';
import {
  ACCOUNT_SIZES,
  DISCRIMINATORS,
  type ClusterId,
} from '../../src/solana/shared.js';
import { programIdForCluster } from '../../src/solana/programId.js';
import {
  aggregateFeeRecords,
  computeCollectibleLamports,
} from '../../src/solana/statsMath.js';
import { rpcUrlForCluster } from './env.js';

export const CACHE_TTL_SECONDS = 30;

interface CacheEntry {
  expiresAt: number;
  stats: Omit<ProtocolStats, 'cache'>;
}

const cache = new Map<ClusterId, CacheEntry>();
const inFlightRequests = new Map<ClusterId, Promise<Omit<ProtocolStats, 'cache'>>>();

function discriminatorFilter(discriminator: number): GetProgramAccountsFilter {
  return {
    memcmp: {
      offset: 0,
      bytes: Buffer.from([discriminator]).toString('base64'),
      encoding: 'base64',
    },
  } as GetProgramAccountsFilter;
}

export async function getCachedProtocolStats(
  cluster: ClusterId,
): Promise<ProtocolStats> {
  const now = Date.now();
  const cached = cache.get(cluster);
  if (cached && cached.expiresAt > now) {
    return {
      ...cached.stats,
      cache: {
        hit: true,
        ttlSeconds: Math.ceil((cached.expiresAt - now) / 1000),
      },
    };
  }

  const stats = await fetchProtocolStatsOnce(cluster);
  cache.set(cluster, {
    stats,
    expiresAt: now + CACHE_TTL_SECONDS * 1000,
  });

  return {
    ...stats,
    cache: {
      hit: false,
      ttlSeconds: CACHE_TTL_SECONDS,
    },
  };
}

async function fetchProtocolStatsOnce(
  cluster: ClusterId,
): Promise<Omit<ProtocolStats, 'cache'>> {
  const inFlight = inFlightRequests.get(cluster);
  if (inFlight) return inFlight;

  const request = fetchProtocolStatsFromRpc(cluster).finally(() => {
    inFlightRequests.delete(cluster);
  });
  inFlightRequests.set(cluster, request);
  return request;
}

async function fetchWalletAccountCount(
  connection: Connection,
  programId: PublicKey,
): Promise<number> {
  const accounts = await connection.getProgramAccounts(programId, {
    dataSlice: { offset: 0, length: 0 },
    filters: [
      { dataSize: ACCOUNT_SIZES.wallet },
      discriminatorFilter(DISCRIMINATORS.wallet),
    ],
  });
  return accounts.length;
}

async function fetchFeeRecords(
  connection: Connection,
  programId: PublicKey,
): Promise<{ rows: FeeRecordRow[]; skipped: number }> {
  const accounts = await connection.getProgramAccounts(programId, {
    filters: [
      { dataSize: ACCOUNT_SIZES.feeRecord },
      discriminatorFilter(DISCRIMINATORS.feeRecord),
    ],
  });

  let skipped = 0;
  const rows: FeeRecordRow[] = [];
  for (const { pubkey, account } of accounts) {
    try {
      const decoded = decodeFeeRecord(account.data);
      rows.push({
        address: pubkey.toBase58(),
        discriminator: decoded.discriminator,
        bump: decoded.bump,
        version: decoded.version,
        totalFeesPaidLamports: decoded.totalFeesPaid.toString(),
        txCount: decoded.txCount,
        walletCount: decoded.walletCount,
        registeredAt: decoded.registeredAt.toString(),
      });
    } catch {
      skipped += 1;
    }
  }

  rows.sort((a, b) => {
    const left = BigInt(a.totalFeesPaidLamports);
    const right = BigInt(b.totalFeesPaidLamports);
    if (left === right) return b.txCount - a.txCount;
    return left > right ? -1 : 1;
  });

  return { rows, skipped };
}

async function fetchShards(
  connection: Connection,
  programId: PublicKey,
  numShards: number,
): Promise<{ rows: ShardRow[]; skipped: number }> {
  const rentMinimum = BigInt(
    await connection.getMinimumBalanceForRentExemption(
      ACCOUNT_SIZES.treasuryShard,
    ),
  );
  let skipped = 0;
  const rows: ShardRow[] = [];

  const addresses = Array.from({ length: numShards }, (_, shardId) =>
    findTreasuryShardPda(shardId, programId),
  );
  const infos = await connection.getMultipleAccountsInfo(addresses, 'confirmed');

  for (let shardId = 0; shardId < numShards; shardId += 1) {
    const address = addresses[shardId];
    const info = infos[shardId];

    if (!info) {
      skipped += 1;
      rows.push({
        shardId,
        address: address.toBase58(),
        balanceLamports: '0',
        collectibleLamports: '0',
        skippedReason: 'Missing account',
      });
      continue;
    }

    try {
      const decoded = decodeTreasuryShard(info.data);
      const balanceLamports = BigInt(info.lamports);
      rows.push({
        shardId: decoded.shardId,
        address: address.toBase58(),
        balanceLamports: balanceLamports.toString(),
        collectibleLamports: computeCollectibleLamports(
          balanceLamports,
          rentMinimum,
        ).toString(),
      });
    } catch (error) {
      skipped += 1;
      rows.push({
        shardId,
        address: address.toBase58(),
        balanceLamports: BigInt(info.lamports).toString(),
        collectibleLamports: '0',
        skippedReason: error instanceof Error ? error.message : 'Decode error',
      });
    }
  }

  return { rows, skipped };
}

function toConfigJson(config: ReturnType<typeof decodeProtocolConfig>): ProtocolConfigJson {
  return {
    discriminator: config.discriminator,
    version: config.version,
    bump: config.bump,
    enabled: config.enabled,
    numShards: config.numShards,
    admin: config.admin.toBase58(),
    treasury: config.treasury.toBase58(),
    creationFeeLamports: config.creationFee.toString(),
    executionFeeLamports: config.executionFee.toString(),
  };
}

async function fetchProtocolStatsFromRpc(
  cluster: ClusterId,
): Promise<Omit<ProtocolStats, 'cache'>> {
  const rpcUrl = rpcUrlForCluster(cluster);
  const connection = new Connection(rpcUrl, 'confirmed');
  const programId = programIdForCluster(cluster);
  const protocolConfigAddress = findProtocolConfigPda(programId);
  const fetchedAt = new Date().toISOString();

  const [slot, configInfo] = await Promise.all([
    connection.getSlot('confirmed'),
    connection.getAccountInfo(protocolConfigAddress, 'confirmed'),
  ]);

  if (!configInfo) {
    return {
      cluster,
      programId: programId.toBase58(),
      protocolConfigAddress: protocolConfigAddress.toBase58(),
      slot,
      fetchedAt,
      initialized: false,
      config: null,
      walletAccountCount: 0,
      feeRecords: [],
      feeTotals: aggregateFeeRecords([]),
      shards: [],
      collectibleFeesLamports: '0',
      shardBalancesLamports: '0',
      skippedAccounts: 0,
    };
  }

  const config = decodeProtocolConfig(configInfo.data);
  const [walletAccountCount, feeRecordsResult, shardResult] = await Promise.all([
    fetchWalletAccountCount(connection, programId),
    fetchFeeRecords(connection, programId),
    fetchShards(connection, programId, config.numShards),
  ]);

  const feeTotals = aggregateFeeRecords(feeRecordsResult.rows);
  const collectibleFeesLamports = shardResult.rows.reduce(
    (sum, shard) => sum + BigInt(shard.collectibleLamports),
    0n,
  );
  const shardBalancesLamports = shardResult.rows.reduce(
    (sum, shard) => sum + BigInt(shard.balanceLamports),
    0n,
  );

  return {
    cluster,
    programId: programId.toBase58(),
    protocolConfigAddress: protocolConfigAddress.toBase58(),
    slot,
    fetchedAt,
    initialized: true,
    config: toConfigJson(config),
    walletAccountCount,
    feeRecords: feeRecordsResult.rows,
    feeTotals,
    shards: shardResult.rows,
    collectibleFeesLamports: collectibleFeesLamports.toString(),
    shardBalancesLamports: shardBalancesLamports.toString(),
    skippedAccounts: feeRecordsResult.skipped + shardResult.skipped,
  };
}
