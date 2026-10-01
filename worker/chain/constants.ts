// Chain constants for the worker. Instruction tags come from the published SDKs where they export them; the
// v2 SDK index does not re-export 15, 16 and 18, so those are local (and pinned by tests).

export { IX, FLAGS, KIND_NOISE, KIND_NONE, KIND_UNPARSED, MAX_IX_KIND, PROGRAMS } from '../../src/types/protocol.js';

export const PARSER_VERSION = 1;

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
export const SECP256R1_PROGRAM = 'Secp256r1SigVerify1111111111111111111111111';
export const BPF_LOADER_UPGRADEABLE = 'BPFLoaderUpgradeab1e11111111111111111111111';

/** Account discriminators (byte 0 of account data). v1 and v2 are separate namespaces. */
export const ACCOUNT_DISC_V1 = {
  wallet: 1,
  authority: 2,
  session: 3,
  deferred: 4,
  protocolConfig: 5,
  feeRecord: 6,
  treasuryShard: 7,
} as const;

export const ACCOUNT_DISC_V2 = {
  wallet: 0x21,
  authority: 0x22,
  session: 0x23,
  deferred: 0x24,
  protocolConfig: 0x25,
  feeRecord: 0x26,
  treasuryShard: 0x27,
} as const;

export type AccountDiscs = { readonly [K in keyof typeof ACCOUNT_DISC_V1]: number };

export function accountDiscs(version: 1 | 2): AccountDiscs {
  return version === 1 ? ACCOUNT_DISC_V1 : ACCOUNT_DISC_V2;
}

/** ProtocolConfig size: v1 88 B, v2 120 B (adds pending_admin). */
export const PROTOCOL_CONFIG_SIZE = { 1: 88, 2: 120 } as const;

/** BPF upgradeable loader instruction tags (u32 LE). */
export const LOADER_IX = { DeployWithMaxDataLen: 2, Upgrade: 3, ExtendProgram: 6 } as const;

/** System program Transfer tag (u32 LE). */
export const SYSTEM_TRANSFER = 2;
