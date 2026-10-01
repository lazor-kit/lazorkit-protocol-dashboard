// Contracts between the worker, the parser and the database (spec §4.1 lk.events, §6).

import type { Cluster, ProtocolVersion } from '../src/types/protocol.js';

/** One lk.events row. Keys are the column names, so the batch is posted to lk_ingest as-is. */
export interface EventRow {
  signature: string;
  ix_seq: number;
  slot: number;
  block_time: string; // ISO-8601 UTC
  kind: number; // 0..18, 253 unparsed, 254 noise, 255 no LazorKit instruction
  top_ix: number | null;
  inner_ix: boolean;
  ok: boolean;
  fail_class: string | null;
  err_code: number | null;
  wallet: string | null;
  payer: string | null;
  auth: number | null; // 1 passkey, 2 session, 3 ed25519, 4 deferred
  fee_lamports: number;
  amount_lamports: number | null;
  tokens: number | null;
  ref: string | null;
  app: string | null;
  cpi: string[] | null;
  tx_version: number | null; // -1 legacy, 0, 1
  net_fee_lamports: number | null;
  shared: boolean;
  flags: number;
  parser_version: number;
}

/** getTransaction(encoding 'json', maxSupportedTransactionVersion 1) result, the parts the parser reads. */
export interface RawInstruction {
  programIdIndex: number;
  accounts: number[];
  data: string; // base58
  stackHeight?: number | null;
}

export interface RawTransaction {
  slot: number;
  blockTime: number | null;
  version?: 'legacy' | number;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: string[];
      header: { numRequiredSignatures: number; numReadonlySignedAccounts: number; numReadonlyUnsignedAccounts: number };
      instructions: RawInstruction[];
      recentBlockhash?: string;
    };
  };
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    innerInstructions?: Array<{ index: number; instructions: RawInstruction[] }> | null;
    loadedAddresses?: { writable: string[]; readonly: string[] } | null;
    logMessages?: string[] | null;
  } | null;
}

/** What the parser needs to know about the program a transaction is parsed for. */
export interface ParseContext {
  programKey: number;
  programId: string;
  version: ProtocolVersion;
  cluster: Cluster;
  otherProgramId: string | null; // the other LazorKit program of this cluster (for `shared`)
  shardSet: ReadonlySet<string>; // canonical TreasuryShard PDAs, ids 0..255
  configPda: string;
  sessionPda(wallet: string, sessionKey: string): string | null;
  authorityPda(wallet: string, idSeed: string): string | null;
  parserVersion: number;
}

export interface SignatureInfo {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
}

export interface PendingSignature {
  signature: string;
  slot: number;
  block_time: string;
  err: unknown;
  attempts: number;
}
