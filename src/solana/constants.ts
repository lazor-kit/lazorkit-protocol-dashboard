import {
  ACCOUNT_SIZES,
  DISCRIMINATORS,
  PROGRAM_ADDRESSES,
  programIdForCluster,
  type ClusterId,
} from './shared';

export const CLUSTERS: Record<
  ClusterId,
  {
    label: string;
    programAddress: string;
    explorerCluster?: string;
  }
> = {
  mainnet: {
    label: 'Mainnet',
    programAddress: PROGRAM_ADDRESSES.mainnet,
  },
  devnet: {
    label: 'Devnet',
    programAddress: PROGRAM_ADDRESSES.devnet,
    explorerCluster: 'devnet',
  },
  localnet: {
    label: 'Localhost',
    programAddress: PROGRAM_ADDRESSES.localnet,
    explorerCluster: 'custom',
  },
};

export const DEFAULT_CLUSTER: ClusterId =
  import.meta.env.VITE_DEFAULT_CLUSTER === 'devnet' ? 'devnet' : 'mainnet';

export { ACCOUNT_SIZES, DISCRIMINATORS, programIdForCluster, type ClusterId };
