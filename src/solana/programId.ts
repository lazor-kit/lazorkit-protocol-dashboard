import { PublicKey } from '@solana/web3.js';
import { PROGRAM_ADDRESSES, type ClusterId } from './shared.js';

export function programIdForCluster(cluster: ClusterId): PublicKey {
  return new PublicKey(PROGRAM_ADDRESSES[cluster]);
}
