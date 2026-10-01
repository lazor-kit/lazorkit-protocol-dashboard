// Protocol facts shared by the worker, the API and the SPA. No runtime dependencies.
// Sources: the rebuild spec §2.1 / §6, program source v1@ff125de and v2@5fb8d46 (lazorkit-protocol).

export type Cluster = 'mainnet' | 'devnet';
export type ProtocolVersion = 1 | 2;

export interface ProgramInfo {
  programKey: 1 | 2 | 3 | 4;
  cluster: Cluster;
  version: ProtocolVersion;
  programId: string;
  label: string;
}

/** The four tracked deployments (lk.programs seeds the same rows). */
export const PROGRAMS: readonly ProgramInfo[] = [
  { programKey: 1, cluster: 'mainnet', version: 1, programId: 'LazorjRFNavitUaBu5m3WaNPjU1maipvSW2rZfAFAKi', label: 'v1 mainnet' },
  { programKey: 2, cluster: 'mainnet', version: 2, programId: 'LazorFroiVuAjcwwQ2me83vTr5nc5NRxSaTg3pmEXC8', label: 'v2 mainnet' },
  { programKey: 3, cluster: 'devnet', version: 1, programId: '4h3XoNReAgEcHVxcZ8sw2aufi9MTr7BbvYYjzjWDyDxS', label: 'v1 devnet' },
  { programKey: 4, cluster: 'devnet', version: 2, programId: '57bTNWqtYTJbWuLWASKo6GqUTAK6oFDUR5c6hEc6V8nv', label: 'v2 devnet' },
];

export function programByKey(programKey: number): ProgramInfo | undefined {
  return PROGRAMS.find((program) => program.programKey === programKey);
}

/** Instruction discriminators (byte 0 of the instruction data). Identical in v1 and v2 for 0-14. */
export const IX = {
  CreateWallet: 0,
  AddAuthority: 1,
  RemoveAuthority: 2,
  TransferOwnership: 3,
  Execute: 4,
  CreateSession: 5,
  Authorize: 6,
  ExecuteDeferred: 7,
  ReclaimDeferred: 8,
  RevokeSession: 9,
  InitializeProtocol: 10,
  UpdateProtocol: 11,
  RegisterPayer: 12,
  WithdrawTreasury: 13,
  InitializeTreasuryShard: 14,
  ProposeAdminRotation: 15,
  AcceptAdminRotation: 16,
  MigrateWallet: 17,
  CloseExpiredSession: 18,
} as const;

export const MAX_IX_KIND = 18;

/** Event kinds above the instruction range. */
export const KIND_UNPARSED = 253; // a signature no endpoint served after 5 runs (a gap)
export const KIND_NOISE = 254; // a LazorKit instruction with empty or unknown data (e.g. program-ping bots)
export const KIND_NONE = 255; // a transaction in the program's feed without a LazorKit instruction

export const INSTRUCTION_NAMES: Readonly<Record<number, string>> = {
  0: 'CreateWallet',
  1: 'AddAuthority',
  2: 'RemoveAuthority',
  3: 'TransferOwnership',
  4: 'Execute',
  5: 'CreateSession',
  6: 'Authorize',
  7: 'ExecuteDeferred',
  8: 'ReclaimDeferred',
  9: 'RevokeSession',
  10: 'InitializeProtocol',
  11: 'UpdateProtocol',
  12: 'RegisterPayer',
  13: 'WithdrawTreasury',
  14: 'InitializeTreasuryShard',
  15: 'ProposeAdminRotation',
  16: 'AcceptAdminRotation',
  17: 'MigrateWallet',
  18: 'CloseExpiredSession',
  253: 'Unparsed (gap)',
  254: 'Noise',
  255: 'No LazorKit instruction',
};

/** Signer class of an operation (events.auth). */
export const AUTH_NAMES: Readonly<Record<number, 'passkey' | 'session' | 'ed25519' | 'deferred'>> = {
  1: 'passkey',
  2: 'session',
  3: 'ed25519',
  4: 'deferred',
};

/** Event flag bits (events.flags). */
export const FLAGS = {
  HISTORY_START: 1,
  LOADER_OP: 2,
  SHORT_DATA: 4,
  NO_CDJ: 8,
  FEE_SUFFIX: 16,
  PARSE_ERROR: 32,
  UNPARSED: 64,
} as const;

export const FAIL_CLASS_DEFINITIONS = {
  lazorkit: 'LazorKit rejected the instruction (its own error codes 3001+ / 4001+, or another program error raised by LazorKit)',
  duplicate: 'A duplicate submit: AccountAlreadyInitialized, or 3006 SignatureReused (passkey counter race)',
  cpi: 'A program called by the wallet failed (custom code below 3001 under a LazorKit instruction)',
  limits: 'Compute or loaded-data limits (ProgramFailedToComplete, ComputationalBudgetExceeded, MaxLoadedAccountsDataSizeExceeded)',
  other_ix: 'Another instruction of the transaction failed (precompile, ComputeBudget, another program)',
  retired: 'Called a v1 instruction retired by the sunset build (4018 RetiredDeployment)',
  noise: 'A transaction without real LazorKit activity (e.g. a program-ping bot) that failed',
  other: 'A transaction-level failure without an instruction index',
} as const;
