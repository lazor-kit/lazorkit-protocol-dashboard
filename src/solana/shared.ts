import { PublicKey } from '@solana/web3.js';

export type ClusterId = 'mainnet' | 'devnet' | 'localnet';

export const PROGRAM_ADDRESSES: Record<ClusterId, string> = {
  mainnet: 'LazorjRFNavitUaBu5m3WaNPjU1maipvSW2rZfAFAKi',
  devnet: '4h3XoNReAgEcHVxcZ8sw2aufi9MTr7BbvYYjzjWDyDxS',
  localnet: '4h3XoNReAgEcHVxcZ8sw2aufi9MTr7BbvYYjzjWDyDxS',
};

export const ACCOUNT_SIZES = {
  wallet: 8,
  protocolConfig: 88,
  feeRecord: 32,
  treasuryShard: 8,
} as const;

export const DISCRIMINATORS = {
  wallet: 1,
  protocolConfig: 5,
  feeRecord: 6,
  treasuryShard: 7,
} as const;

export function isClusterId(value: unknown): value is ClusterId {
  return value === 'mainnet' || value === 'devnet' || value === 'localnet';
}

export function programIdForCluster(cluster: ClusterId): PublicKey {
  return new PublicKey(PROGRAM_ADDRESSES[cluster]);
}
