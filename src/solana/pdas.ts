import { PublicKey } from '@solana/web3.js';

const encoder = new TextEncoder();

export function findProtocolConfigPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [encoder.encode('protocol_config')],
    programId,
  )[0];
}

export function findTreasuryShardPda(
  shardId: number,
  programId: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [encoder.encode('treasury_shard'), new Uint8Array([shardId])],
    programId,
  )[0];
}

