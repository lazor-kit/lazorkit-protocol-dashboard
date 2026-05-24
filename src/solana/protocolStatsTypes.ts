import type { ClusterId } from './shared';

export interface ProtocolConfigJson {
  discriminator: number;
  version: number;
  bump: number;
  enabled: boolean;
  numShards: number;
  admin: string;
  treasury: string;
  creationFeeLamports: string;
  executionFeeLamports: string;
}

export interface FeeRecordRow {
  address: string;
  discriminator: number;
  bump: number;
  version: number;
  totalFeesPaidLamports: string;
  txCount: number;
  walletCount: number;
  registeredAt: string;
}

export interface ShardRow {
  shardId: number;
  address: string;
  balanceLamports: string;
  collectibleLamports: string;
  skippedReason?: string;
}

export interface AggregatedFeeRecords {
  recordCount: number;
  lifetimeFeesLamports: string;
  txCount: number;
  walletCount: number;
  feePayingEvents: number;
}

export interface ProtocolStats {
  cluster: ClusterId;
  programId: string;
  protocolConfigAddress: string;
  slot: number;
  fetchedAt: string;
  cache: {
    hit: boolean;
    ttlSeconds: number;
  };
  initialized: boolean;
  config: ProtocolConfigJson | null;
  walletAccountCount: number;
  feeRecords: FeeRecordRow[];
  feeTotals: AggregatedFeeRecords;
  shards: ShardRow[];
  collectibleFeesLamports: string;
  shardBalancesLamports: string;
  skippedAccounts: number;
}
