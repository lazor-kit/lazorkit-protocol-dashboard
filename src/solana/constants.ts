import { PublicKey } from '@solana/web3.js';

export type ClusterId = 'mainnet' | 'devnet' | 'localnet';

export const CLUSTERS: Record<
  ClusterId,
  {
    label: string;
    programAddress: string;
    rpcUrl: string;
    explorerCluster?: string;
  }
> = {
  mainnet: {
    label: 'Mainnet',
    programAddress: 'LazorjRFNavitUaBu5m3WaNPjU1maipvSW2rZfAFAKi',
    rpcUrl:
      import.meta.env.VITE_MAINNET_RPC_URL ??
      'https://api.mainnet-beta.solana.com',
  },
  devnet: {
    label: 'Devnet',
    programAddress: '4h3XoNReAgEcHVxcZ8sw2aufi9MTr7BbvYYjzjWDyDxS',
    rpcUrl:
      import.meta.env.VITE_DEVNET_RPC_URL ?? 'https://api.devnet.solana.com',
    explorerCluster: 'devnet',
  },
  localnet: {
    label: 'Localhost',
    programAddress: '4h3XoNReAgEcHVxcZ8sw2aufi9MTr7BbvYYjzjWDyDxS',
    rpcUrl: import.meta.env.VITE_LOCALNET_RPC_URL ?? 'http://127.0.0.1:8899',
    explorerCluster: 'custom',
  },
};

export const DEFAULT_CLUSTER: ClusterId =
  import.meta.env.VITE_DEFAULT_CLUSTER === 'devnet' ||
  import.meta.env.VITE_DEFAULT_CLUSTER === 'localnet'
    ? import.meta.env.VITE_DEFAULT_CLUSTER
    : 'mainnet';

export const DISCRIMINATORS = {
  wallet: 1,
  protocolConfig: 5,
  feeRecord: 6,
  treasuryShard: 7,
} as const;

export const ACCOUNT_SIZES = {
  wallet: 8,
  protocolConfig: 88,
  feeRecord: 32,
  treasuryShard: 8,
} as const;

export function programIdForCluster(cluster: ClusterId): PublicKey {
  return new PublicKey(CLUSTERS[cluster].programAddress);
}

