// Deployment and binary detection (spec §5.2). A cheap 36 B + 45 B read every run; the full programdata
// (~140-185 KB) only when the deploy slot changed (an upgrade) or the hash is unknown.

import { identifyElf, parseProgramAccount, parseProgramdataHeader, PROGRAMDATA_HEADER_BYTES, classifyBinary } from '../chain/binary.js';
import type { DbProgram, Deployment, LkDb } from '../db/client.js';
import type { RpcClient } from '../rpc/client.js';

interface AccountInfoResponse {
  context: { slot: number };
  value: { data: [string, string]; lamports: number; owner: string; executable: boolean } | null;
}

function bytes(value: NonNullable<AccountInfoResponse['value']>): Uint8Array {
  return new Uint8Array(Buffer.from(value.data[0], 'base64'));
}

export interface DeploymentResult {
  deployed: boolean;
  deployment: Deployment;
}

export async function blockTimeIso(rpc: RpcClient, fallback: RpcClient | null, slot: number): Promise<string | null> {
  for (const client of fallback && fallback !== rpc ? [rpc, fallback] : [rpc]) {
    try {
      const seconds = await client.call<number | null>('getBlockTime', [slot]);
      if (typeof seconds === 'number') return new Date(seconds * 1000).toISOString();
    } catch {
      // try the next endpoint
    }
  }
  return null;
}

export async function detectDeployment(
  rpc: RpcClient,
  archival: RpcClient,
  db: LkDb,
  program: DbProgram,
  knownBinaries: ReadonlyArray<{ sha256: string; kind: string }>,
): Promise<DeploymentResult> {
  const account = await rpc.call<AccountInfoResponse>('getAccountInfo', [
    program.programId,
    { encoding: 'base64', dataSlice: { offset: 0, length: 36 }, commitment: 'finalized' },
  ]);
  if (!account.value) {
    const deployment: Deployment = { status: 'not_deployed' };
    await db.setDeployment(program.programKey, deployment);
    return { deployed: false, deployment };
  }
  const programdata = parseProgramAccount(bytes(account.value));
  const header = await rpc.call<AccountInfoResponse>('getAccountInfo', [
    programdata,
    { encoding: 'base64', dataSlice: { offset: 0, length: PROGRAMDATA_HEADER_BYTES }, commitment: 'finalized' },
  ]);
  if (!header.value) throw new Error(`programdata ${programdata} of ${program.programId} not found`);
  const { deploySlot, upgradeAuthority } = parseProgramdataHeader(bytes(header.value));

  let deployment: Deployment;
  if (deploySlot !== program.lastDeploySlot || !program.binarySha256) {
    const full = await rpc.call<AccountInfoResponse>('getAccountInfo', [
      programdata,
      { encoding: 'base64', commitment: 'finalized' },
    ]);
    if (!full.value) throw new Error(`programdata ${programdata} disappeared`);
    const identity = identifyElf(bytes(full.value).subarray(PROGRAMDATA_HEADER_BYTES));
    deployment = {
      status: 'live',
      programdata,
      deploy_slot: deploySlot,
      deployed_at: await blockTimeIso(rpc, archival, deploySlot),
      upgrade_authority: upgradeAuthority,
      sha256: identity.sha256,
      elf_size: identity.elfSize,
      kind: classifyBinary(identity, knownBinaries),
    };
  } else {
    deployment = { status: 'live', programdata, upgrade_authority: upgradeAuthority };
  }
  await db.setDeployment(program.programKey, deployment);
  return { deployed: true, deployment };
}
