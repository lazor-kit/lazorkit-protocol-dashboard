// Transaction-level failure classes (spec §6.6). The same class goes on every row of the transaction.

import type { FailClass } from '../../src/types/dashboard.js';

const LIMIT_ERRORS = new Set([
  'MaxLoadedAccountsDataSizeExceeded',
  'InvalidLoadedAccountsDataSizeLimit',
  'ComputeBudgetExceeded',
  'ComputationalBudgetExceeded',
  'WouldExceedMaxBlockCostLimit',
  'WouldExceedMaxAccountCostLimit',
  'WouldExceedAccountDataBlockLimit',
  'WouldExceedAccountDataTotalLimit',
  'WouldExceedMaxVoteCostLimit',
  'ProgramFailedToComplete',
]);

export interface FailureInfo {
  failClass: FailClass | null;
  errCode: number | null;
  instructionIndex: number | null;
}

function errorName(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    return keys.length === 1 ? keys[0] : null;
  }
  return null;
}

/**
 * isLazorKitIx(i): is top-level instruction i one of this program's instructions?
 * isNoiseIx(i): is it a noise instruction (empty or unknown data)?
 */
export function classifyFailure(
  err: unknown,
  isLazorKitIx: (index: number) => boolean,
  isNoiseIx: (index: number) => boolean,
): FailureInfo {
  if (err === null || err === undefined) return { failClass: null, errCode: null, instructionIndex: null };
  const instructionError =
    err && typeof err === 'object' && 'InstructionError' in (err as Record<string, unknown>)
      ? (err as { InstructionError: unknown }).InstructionError
      : null;
  if (!Array.isArray(instructionError) || instructionError.length < 2 || typeof instructionError[0] !== 'number') {
    const name = errorName(err);
    return { failClass: name && LIMIT_ERRORS.has(name) ? 'limits' : 'other', errCode: null, instructionIndex: null };
  }
  const index = instructionError[0] as number;
  const detail = instructionError[1] as unknown;
  const custom =
    detail && typeof detail === 'object' && 'Custom' in (detail as Record<string, unknown>)
      ? Number((detail as { Custom: unknown }).Custom)
      : null;
  const errCode = custom !== null && Number.isFinite(custom) ? custom : null;
  if (!isLazorKitIx(index)) return { failClass: 'other_ix', errCode, instructionIndex: index };
  if (isNoiseIx(index)) return { failClass: 'noise', errCode, instructionIndex: index };
  if (errCode !== null) {
    if (errCode === 4018) return { failClass: 'retired', errCode, instructionIndex: index };
    if (errCode === 3006) return { failClass: 'duplicate', errCode, instructionIndex: index };
    if (errCode >= 3001) return { failClass: 'lazorkit', errCode, instructionIndex: index };
    return { failClass: 'cpi', errCode, instructionIndex: index };
  }
  const name = errorName(detail);
  if (name === 'AccountAlreadyInitialized') return { failClass: 'duplicate', errCode, instructionIndex: index };
  if (name === 'ProgramFailedToComplete' || name === 'ComputationalBudgetExceeded') {
    return { failClass: 'limits', errCode, instructionIndex: index };
  }
  return { failClass: 'lazorkit', errCode, instructionIndex: index };
}
