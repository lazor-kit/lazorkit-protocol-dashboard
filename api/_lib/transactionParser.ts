import bs58 from 'bs58';
import {
  PublicKey,
  SystemProgram,
  type ParsedInstruction,
  type ParsedTransactionWithMeta,
  type PartiallyDecodedInstruction,
} from '@solana/web3.js';
import type {
  LazorKitMethod,
  TransactionStatus,
} from '../../src/solana/dashboardTypes.js';
import {
  DISCRIMINATORS,
  type ClusterId,
} from '../../src/solana/shared.js';
import { programIdForCluster } from '../../src/solana/programId.js';
import type { ProtocolTransactionRow } from './database.js';

export interface ParsedLazorKitTransaction {
  row: ProtocolTransactionRow | null;
  warnings: string[];
}

const METHOD_BY_DISCRIMINATOR: Record<number, LazorKitMethod | undefined> = {
  [DISCRIMINATORS.createWallet]: 'CreateWallet',
  [DISCRIMINATORS.execute]: 'Execute',
  [DISCRIMINATORS.executeDeferred]: 'ExecuteDeferred',
};

export function parseLazorKitTransaction(
  cluster: ClusterId,
  signature: string,
  tx: ParsedTransactionWithMeta | null,
): ParsedLazorKitTransaction {
  const warnings: string[] = [];
  if (!tx) return { row: null, warnings: ['Transaction not found'] };
  if (!tx.meta) return { row: null, warnings: ['Transaction metadata missing'] };

  const blockTime =
    typeof tx.blockTime === 'number'
      ? new Date(tx.blockTime * 1000).toISOString()
      : new Date(0).toISOString();
  if (typeof tx.blockTime !== 'number') warnings.push('Missing blockTime');

  const accountKeys = tx.transaction.message.accountKeys.map((key) =>
    key.pubkey.toBase58(),
  );
  const feePayer = accountKeys[0];
  if (!feePayer) {
    return { row: null, warnings: ['Transaction payer missing'] };
  }

  const programId = programIdForCluster(cluster).toBase58();
  const instructions = tx.transaction.message.instructions;

  for (const [instructionIndex, instruction] of instructions.entries()) {
    const parsed = parseInstruction(programId, instruction);
    if (!parsed) continue;

    const status: TransactionStatus = tx.meta.err ? 'failed' : 'success';
    const suffix = parseFeeSuffix(parsed.accounts);
    warnings.push(...parsed.warnings, ...suffix.warnings);

    const protocolFeeLamports =
      status === 'success' && suffix.treasuryShard
        ? computePositiveLamportDelta(
            suffix.treasuryShard,
            accountKeys,
            tx.meta.preBalances,
            tx.meta.postBalances,
          )
        : 0n;

    if (status === 'success' && suffix.treasuryShard && protocolFeeLamports === 0n) {
      warnings.push('No positive treasury shard lamport delta found');
    }

    return {
      row: {
        cluster,
        signature,
        slot: tx.slot,
        block_time: blockTime,
        fee_payer: feePayer,
        wallet_pda: parsed.walletPda,
        method: parsed.method,
        status,
        protocol_fee_lamports: protocolFeeLamports.toString(),
        treasury_shard: suffix.treasuryShard,
        fee_record: suffix.feeRecord,
        instruction_index: instructionIndex,
        parse_warnings: warnings,
      },
      warnings,
    };
  }

  return { row: null, warnings: ['No fee-eligible LazorKit instruction found'] };
}

function parseInstruction(
  programId: string,
  instruction: ParsedInstruction | PartiallyDecodedInstruction,
):
  | {
      method: LazorKitMethod;
      walletPda: string;
      accounts: string[];
      warnings: string[];
    }
  | null {
  if (!('data' in instruction) || !('accounts' in instruction)) return null;
  if (!instruction.programId.equals(new PublicKey(programId))) return null;

  const warnings: string[] = [];
  let discriminator: number | undefined;
  try {
    discriminator = bs58.decode(instruction.data)[0];
  } catch {
    warnings.push('Instruction data decode failed');
    return null;
  }

  const method = METHOD_BY_DISCRIMINATOR[discriminator ?? -1];
  if (!method) return null;

  const accounts = instruction.accounts.map((account) => account.toBase58());
  const walletPda = accounts[1];
  if (!walletPda) warnings.push('Wallet PDA account missing');

  return {
    method,
    walletPda: walletPda ?? PublicKey.default.toBase58(),
    accounts,
    warnings,
  };
}

function parseFeeSuffix(accounts: string[]): {
  feeRecord: string | null;
  treasuryShard: string | null;
  warnings: string[];
} {
  if (accounts.length < 4) {
    return {
      feeRecord: null,
      treasuryShard: null,
      warnings: ['Protocol fee suffix missing'],
    };
  }

  const suffix = accounts.slice(-4);
  if (suffix[3] !== SystemProgram.programId.toBase58()) {
    return {
      feeRecord: null,
      treasuryShard: null,
      warnings: ['Protocol fee suffix missing'],
    };
  }

  return {
    feeRecord: suffix[1] ?? null,
    treasuryShard: suffix[2] ?? null,
    warnings: [],
  };
}

export function computePositiveLamportDelta(
  account: string,
  accountKeys: readonly string[],
  preBalances: readonly number[],
  postBalances: readonly number[],
): bigint {
  const index = accountKeys.indexOf(account);
  if (index < 0) return 0n;
  const pre = BigInt(preBalances[index] ?? 0);
  const post = BigInt(postBalances[index] ?? 0);
  return post > pre ? post - pre : 0n;
}
