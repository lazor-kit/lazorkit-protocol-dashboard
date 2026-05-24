import {
  Connection,
  type GetProgramAccountsFilter,
  type PublicKey,
} from '@solana/web3.js';
import {
  ACCOUNT_SIZES,
  CLUSTERS,
  DISCRIMINATORS,
  type ClusterId,
  programIdForCluster,
} from './constants';
import {
  decodeFeeRecord,
  decodeProtocolConfig,
  decodeTreasuryShard,
  type FeeRecordAccount,
  type ProtocolConfigAccount,
} from './decoders';
import { findProtocolConfigPda, findTreasuryShardPda } from './pdas';

export interface FeeRecordRow extends FeeRecordAccount {
  address: string;
}

export interface ShardRow {
  shardId: number;
  address: string;
  balanceLamports: bigint;
  collectibleLamports: bigint;
  skippedReason?: string;
}

export interface AggregatedFeeRecords {
  recordCount: number;
  lifetimeFeesLamports: bigint;
  txCount: number;
  walletCount: number;
  feePayingEvents: number;
}

export interface ProtocolStats {
  cluster: ClusterId;
  programId: string;
  protocolConfigAddress: string;
  slot: number;
  fetchedAt: Date;
  initialized: boolean;
  config: ProtocolConfigAccount | null;
  walletAccountCount: number;
  feeRecords: FeeRecordRow[];
  feeTotals: AggregatedFeeRecords;
  shards: ShardRow[];
  collectibleFeesLamports: bigint;
  shardBalancesLamports: bigint;
  skippedAccounts: number;
}

function discriminatorFilter(discriminator: number): GetProgramAccountsFilter {
  return {
    memcmp: {
      offset: 0,
      bytes: btoa(String.fromCharCode(discriminator)),
      encoding: 'base64',
    },
  } as GetProgramAccountsFilter;
}

export function aggregateFeeRecords(
  feeRecords: ReadonlyArray<FeeRecordRow>,
): AggregatedFeeRecords {
  return feeRecords.reduce<AggregatedFeeRecords>(
    (acc, row) => ({
      recordCount: acc.recordCount + 1,
      lifetimeFeesLamports: acc.lifetimeFeesLamports + row.totalFeesPaid,
      txCount: acc.txCount + row.txCount,
      walletCount: acc.walletCount + row.walletCount,
      feePayingEvents: acc.feePayingEvents + row.txCount + row.walletCount,
    }),
    {
      recordCount: 0,
      lifetimeFeesLamports: 0n,
      txCount: 0,
      walletCount: 0,
      feePayingEvents: 0,
    },
  );
}

export function computeCollectibleLamports(
  balanceLamports: bigint,
  rentMinimumLamports: bigint,
): bigint {
  return balanceLamports > rentMinimumLamports
    ? balanceLamports - rentMinimumLamports
    : 0n;
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
      rows.push({
        address: pubkey.toBase58(),
        ...decodeFeeRecord(account.data),
      });
    } catch {
      skipped += 1;
    }
  }

  rows.sort((a, b) => {
    if (a.totalFeesPaid === b.totalFeesPaid) return b.txCount - a.txCount;
    return a.totalFeesPaid > b.totalFeesPaid ? -1 : 1;
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

  for (let shardId = 0; shardId < numShards; shardId += 1) {
    const address = findTreasuryShardPda(shardId, programId);
    const [info, balance] = await Promise.all([
      connection.getAccountInfo(address, 'confirmed'),
      connection.getBalance(address, 'confirmed'),
    ]);

    if (!info) {
      skipped += 1;
      rows.push({
        shardId,
        address: address.toBase58(),
        balanceLamports: 0n,
        collectibleLamports: 0n,
        skippedReason: 'Missing account',
      });
      continue;
    }

    try {
      const decoded = decodeTreasuryShard(info.data);
      rows.push({
        shardId: decoded.shardId,
        address: address.toBase58(),
        balanceLamports: BigInt(balance),
        collectibleLamports: computeCollectibleLamports(
          BigInt(balance),
          rentMinimum,
        ),
      });
    } catch (error) {
      skipped += 1;
      rows.push({
        shardId,
        address: address.toBase58(),
        balanceLamports: BigInt(balance),
        collectibleLamports: 0n,
        skippedReason: error instanceof Error ? error.message : 'Decode error',
      });
    }
  }

  return { rows, skipped };
}

export async function fetchProtocolStats(
  cluster: ClusterId,
): Promise<ProtocolStats> {
  const rpcUrl = CLUSTERS[cluster].rpcUrl;
  const connection = new Connection(rpcUrl, 'confirmed');
  const programId = programIdForCluster(cluster);
  const protocolConfigAddress = findProtocolConfigPda(programId);
  const fetchedAt = new Date();

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
      collectibleFeesLamports: 0n,
      shardBalancesLamports: 0n,
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
    (sum, shard) => sum + shard.collectibleLamports,
    0n,
  );
  const shardBalancesLamports = shardResult.rows.reduce(
    (sum, shard) => sum + shard.balanceLamports,
    0n,
  );

  return {
    cluster,
    programId: programId.toBase58(),
    protocolConfigAddress: protocolConfigAddress.toBase58(),
    slot,
    fetchedAt,
    initialized: true,
    config,
    walletAccountCount,
    feeRecords: feeRecordsResult.rows,
    feeTotals,
    shards: shardResult.rows,
    collectibleFeesLamports,
    shardBalancesLamports,
    skippedAccounts: feeRecordsResult.skipped + shardResult.skipped,
  };
}
