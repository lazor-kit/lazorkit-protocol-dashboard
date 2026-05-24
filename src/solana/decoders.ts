import { PublicKey } from '@solana/web3.js';
import { ACCOUNT_SIZES, DISCRIMINATORS } from './shared.js';

export interface ProtocolConfigAccount {
  discriminator: number;
  version: number;
  bump: number;
  enabled: boolean;
  numShards: number;
  admin: PublicKey;
  treasury: PublicKey;
  creationFee: bigint;
  executionFee: bigint;
}

export interface FeeRecordAccount {
  discriminator: number;
  bump: number;
  version: number;
  totalFeesPaid: bigint;
  txCount: number;
  walletCount: number;
  registeredAt: bigint;
}

export interface TreasuryShardAccount {
  discriminator: number;
  bump: number;
  shardId: number;
}

function ensureLength(data: Uint8Array, size: number, label: string): void {
  if (data.length < size) {
    throw new Error(`${label} data too short: ${data.length} < ${size}`);
  }
}

function readU64(data: Uint8Array, offset: number): bigint {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(
    offset,
    true,
  );
}

function readU32(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(
    offset,
    true,
  );
}

function readPubkey(data: Uint8Array, start: number, end: number): PublicKey {
  return new PublicKey(data.slice(start, end));
}

export function decodeProtocolConfig(data: Uint8Array): ProtocolConfigAccount {
  ensureLength(data, ACCOUNT_SIZES.protocolConfig, 'ProtocolConfig');
  if (data[0] !== DISCRIMINATORS.protocolConfig) {
    throw new Error(`Invalid ProtocolConfig discriminator: ${data[0]}`);
  }

  return {
    discriminator: data[0],
    version: data[1],
    bump: data[2],
    enabled: data[3] !== 0,
    numShards: data[4],
    admin: readPubkey(data, 8, 40),
    treasury: readPubkey(data, 40, 72),
    creationFee: readU64(data, 72),
    executionFee: readU64(data, 80),
  };
}

export function decodeFeeRecord(data: Uint8Array): FeeRecordAccount {
  ensureLength(data, ACCOUNT_SIZES.feeRecord, 'FeeRecord');
  if (data[0] !== DISCRIMINATORS.feeRecord) {
    throw new Error(`Invalid FeeRecord discriminator: ${data[0]}`);
  }

  return {
    discriminator: data[0],
    bump: data[1],
    version: data[2],
    totalFeesPaid: readU64(data, 8),
    txCount: readU32(data, 16),
    walletCount: readU32(data, 20),
    registeredAt: readU64(data, 24),
  };
}

export function decodeTreasuryShard(data: Uint8Array): TreasuryShardAccount {
  ensureLength(data, ACCOUNT_SIZES.treasuryShard, 'TreasuryShard');
  if (data[0] !== DISCRIMINATORS.treasuryShard) {
    throw new Error(`Invalid TreasuryShard discriminator: ${data[0]}`);
  }

  return {
    discriminator: data[0],
    bump: data[1],
    shardId: data[2],
  };
}
