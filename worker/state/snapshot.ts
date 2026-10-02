// State snapshot (spec §7.1), taken every run BEFORE discovery so the invariants compare history and state at
// the same slot: one unfiltered getProgramAccounts (withContext), the rent minimum for an 8-byte account, and the
// vault balances (system-owned PDAs, invisible to getProgramAccounts) 100 per getMultipleAccounts.

import type { StateDetail, StateTotals } from '../../src/types/dashboard.js';
import { protocolConfigPda, vaultPda } from '../chain/pdas.js';
import type { RpcClient } from '../rpc/client.js';
import { decodeProgramState, type ProgramAccount } from './decoders.js';

interface GpaResponse {
  context: { slot: number };
  value: Array<{ pubkey: string; account: { lamports: number; data: [string, string] | string } }>;
}

interface MultipleAccountsResponse {
  context: { slot: number };
  value: Array<{ lamports: number } | null>;
}

export interface Snapshot {
  slot: number;
  fetchedAt: string;
  totals: StateTotals;
  detail: StateDetail;
}

function accountData(data: [string, string] | string): Uint8Array {
  const encoded = Array.isArray(data) ? data[0] : data;
  return new Uint8Array(Buffer.from(encoded, 'base64'));
}

export async function takeSnapshot(rpc: RpcClient, programId: string, version: 1 | 2): Promise<Snapshot> {
  const gpa = await rpc.call<GpaResponse>('getProgramAccounts', [
    programId,
    { encoding: 'base64', commitment: 'finalized', withContext: true },
  ]);
  const fetchedAt = new Date().toISOString();
  const accounts: ProgramAccount[] = gpa.value.map((entry) => ({
    pubkey: entry.pubkey,
    lamports: entry.account.lamports,
    data: accountData(entry.account.data),
  }));
  const rent = await rpc.call<number>('getMinimumBalanceForRentExemption', [8, { commitment: 'finalized' }]);
  const configPda = protocolConfigPda(version, programId);
  const firstPass = decodeProgramState(accounts, {
    version,
    slot: gpa.context.slot,
    rentMinimum8: BigInt(rent),
    configPda,
  });

  let funded = 0;
  let lamports = 0n;
  const vaults = firstPass.wallets.map((wallet) => vaultPda(version, programId, wallet));
  for (let i = 0; i < vaults.length; i += 100) {
    const batch = vaults.slice(i, i + 100);
    const result = await rpc.call<MultipleAccountsResponse>('getMultipleAccounts', [
      batch,
      { encoding: 'base64', commitment: 'finalized', dataSlice: { offset: 0, length: 0 } },
    ]);
    for (const account of result.value) {
      if (!account) continue;
      funded += 1;
      lamports += BigInt(account.lamports);
    }
  }

  const decoded = decodeProgramState(accounts, {
    version,
    slot: gpa.context.slot,
    rentMinimum8: BigInt(rent),
    configPda,
    vaults: { funded, lamports },
  });
  return { slot: gpa.context.slot, fetchedAt, totals: decoded.totals, detail: decoded.detail };
}
