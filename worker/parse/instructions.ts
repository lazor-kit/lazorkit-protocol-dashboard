// Per-kind extraction (spec §6.3 / §6.4). acc[k] is the k-th account of THIS instruction.

import { COMPUTE_BUDGET_PROGRAM, FLAGS, IX, SECP256R1_PROGRAM, SYSTEM_PROGRAM, SYSTEM_TRANSFER } from '../chain/constants.js';
import type { ParseContext } from '../types.js';
import { appFromClientData, normalizeApp, rpIdFromCreateWallet } from './webauthn.js';

export interface DecodedIx {
  programId: string;
  accounts: string[]; // resolved addresses
  accountIndexes: number[]; // indexes into the transaction keys (for balances)
  data: Uint8Array;
  stackHeight: number | null;
}

export interface TxView {
  keys: string[];
  signers: string[];
  preBalances: number[];
  postBalances: number[];
  topLevel: DecodedIx[];
}

export interface IxFields {
  wallet: string | null;
  payer: string | null;
  auth: number | null;
  fee_lamports: number;
  amount_lamports: number | null;
  tokens: number | null;
  ref: string | null;
  app: string | null;
  cpi: string[] | null;
  flags: number;
}

const AUTH = { passkey: 1, session: 2, ed25519: 3, deferred: 4 } as const;

function u64le(data: Uint8Array, offset: number): number | null {
  if (offset + 8 > data.length) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return Number(view.getBigUint64(offset, true));
}

function u32le(data: Uint8Array, offset: number): number | null {
  if (offset + 4 > data.length) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getUint32(offset, true);
}

/** System Transfer: data = u32 LE 2 ‖ u64 lamports; accounts [from, to]. */
export function asSystemTransfer(ix: DecodedIx): { from: string; to: string; lamports: number } | null {
  if (ix.programId !== SYSTEM_PROGRAM || ix.data.length < 12 || ix.accounts.length < 2) return null;
  if (u32le(ix.data, 0) !== SYSTEM_TRANSFER) return null;
  const lamports = u64le(ix.data, 4);
  if (lamports === null) return null;
  return { from: ix.accounts[0], to: ix.accounts[1], lamports };
}

function balance(view: TxView, ix: DecodedIx, position: number, which: 'pre' | 'post'): number | null {
  const keyIndex = ix.accountIndexes[position];
  if (keyIndex === undefined) return null;
  const list = which === 'pre' ? view.preBalances : view.postBalances;
  const value = list[keyIndex];
  return typeof value === 'number' ? value : null;
}

/** §6.4: passkey if the top-level instruction before it is the Secp256r1 precompile, else session or Ed25519 by
 * matching acc[2] against PDAs derived from each transaction signer. */
export function classifySigner(
  view: TxView,
  ix: DecodedIx,
  topIndex: number,
  inner: boolean,
  ctx: ParseContext,
): number | null {
  if (!inner && topIndex > 0 && view.topLevel[topIndex - 1]?.programId === SECP256R1_PROGRAM) return AUTH.passkey;
  const wallet = ix.accounts[1];
  const authority = ix.accounts[2];
  if (!wallet || !authority) return null;
  for (const signer of view.signers) {
    if (ctx.sessionPda(wallet, signer) === authority) return AUTH.session;
    if (ctx.authorityPda(wallet, signer) === authority) return AUTH.ed25519;
  }
  return null;
}

/**
 * Extracts the per-kind fields. `children` are the direct children (inner instructions one stack level below).
 */
export function extractFields(
  kind: number,
  ix: DecodedIx,
  children: DecodedIx[],
  view: TxView,
  topIndex: number,
  inner: boolean,
  ok: boolean,
  ctx: ParseContext,
): IxFields {
  const acc = ix.accounts;
  const fields: IxFields = {
    wallet: null,
    payer: acc[0] ?? null,
    auth: null,
    fee_lamports: 0,
    amount_lamports: null,
    tokens: null,
    ref: null,
    app: null,
    cpi: null,
    flags: 0,
  };
  const need = (accounts: number, dataBytes = 1): boolean => {
    const enough = acc.length >= accounts && ix.data.length >= dataBytes;
    if (!enough) fields.flags |= FLAGS.SHORT_DATA;
    return enough;
  };
  const passkeyApp = () => {
    if (fields.auth !== AUTH.passkey) return;
    const { app, found } = appFromClientData(ix.data);
    fields.app = app;
    if (!found) fields.flags |= FLAGS.NO_CDJ;
  };

  switch (kind) {
    case IX.CreateWallet: {
      if (!need(3, 34)) break;
      fields.wallet = acc[1];
      fields.ref = acc[2];
      const ownerType = ix.data[33];
      fields.auth = ownerType === 1 ? AUTH.passkey : ownerType === 0 ? AUTH.ed25519 : null;
      if (ownerType === 1) {
        const { rpId, short } = rpIdFromCreateWallet(ix.data);
        if (short) fields.flags |= FLAGS.SHORT_DATA;
        fields.app = normalizeApp(rpId);
      }
      break;
    }
    case IX.AddAuthority:
    case IX.RemoveAuthority:
    case IX.TransferOwnership:
    case IX.CreateSession:
    case IX.RevokeSession: {
      if (!need(4)) break;
      fields.wallet = acc[1];
      fields.ref = acc[3];
      fields.auth = classifySigner(view, ix, topIndex, inner, ctx);
      passkeyApp();
      break;
    }
    case IX.Execute: {
      if (!need(4)) break;
      fields.wallet = acc[1];
      fields.ref = acc[3];
      fields.auth = classifySigner(view, ix, topIndex, inner, ctx);
      passkeyApp();
      break;
    }
    case IX.Authorize: {
      if (!need(4)) break;
      fields.wallet = acc[1];
      fields.ref = acc[3];
      fields.auth = AUTH.passkey;
      passkeyApp();
      break;
    }
    case IX.ExecuteDeferred: {
      if (!need(4)) break;
      fields.wallet = acc[1];
      fields.ref = acc[3];
      fields.auth = AUTH.deferred;
      break;
    }
    case IX.ReclaimDeferred: {
      if (!need(2)) break;
      fields.ref = acc[1];
      fields.amount_lamports = balance(view, ix, 1, 'pre');
      break;
    }
    case IX.InitializeProtocol:
    case IX.UpdateProtocol:
    case IX.ProposeAdminRotation:
    case IX.AcceptAdminRotation:
    case IX.RegisterPayer: {
      if (!need(2)) break;
      fields.ref = acc[1];
      break;
    }
    case IX.WithdrawTreasury: {
      if (!need(3)) break;
      fields.ref = acc[2];
      const pre = balance(view, ix, 2, 'pre');
      const post = balance(view, ix, 2, 'post');
      fields.amount_lamports = pre !== null && post !== null ? pre - post : null;
      break;
    }
    case IX.InitializeTreasuryShard: {
      if (!need(4)) break;
      fields.ref = acc[3];
      fields.amount_lamports = balance(view, ix, 3, 'post');
      break;
    }
    case IX.MigrateWallet: {
      if (!need(5, 2)) break;
      fields.wallet = acc[1];
      fields.ref = acc[4];
      fields.tokens = ix.data[1];
      const solMove = children.map(asSystemTransfer).find((t) => t && t.from === acc[3] && t.to === acc[4]);
      if (solMove) {
        fields.amount_lamports = solMove.lamports;
      } else {
        const pre = balance(view, ix, 3, 'pre');
        const post = balance(view, ix, 3, 'post');
        fields.amount_lamports = pre !== null && post !== null ? Math.max(0, pre - post) : null;
      }
      fields.auth = classifySigner(view, ix, topIndex, inner, ctx);
      passkeyApp();
      break;
    }
    case IX.CloseExpiredSession: {
      if (!need(2)) break;
      fields.ref = acc[1];
      fields.amount_lamports = balance(view, ix, 1, 'pre');
      break;
    }
    default:
      break;
  }

  // Fees (§6.6): kinds 0, 4, 7 on successful transactions only. The fee is the first direct-child System
  // Transfer, counted only when it goes from acc[0] to a canonical treasury shard of this program.
  let feeTransfer: DecodedIx | null = null;
  if (kind === IX.CreateWallet || kind === IX.Execute || kind === IX.ExecuteDeferred) {
    const n = acc.length;
    if (n >= 5 && acc[n - 1] === SYSTEM_PROGRAM && acc[n - 4] === ctx.configPda) fields.flags |= FLAGS.FEE_SUFFIX;
    const first = children.find((child) => asSystemTransfer(child) !== null) ?? null;
    const transfer = first ? asSystemTransfer(first) : null;
    if (transfer && transfer.from === acc[0] && ctx.shardSet.has(transfer.to)) {
      feeTransfer = first;
      if (ok) fields.fee_lamports = transfer.lamports;
    }
  }

  // What wallets do (§8.1 F16): distinct programs the vault invoked, excluding the fee transfer, ComputeBudget
  // and LazorKit itself.
  if (kind === IX.Execute || kind === IX.ExecuteDeferred) {
    const programs: string[] = [];
    for (const child of children) {
      if (child === feeTransfer) continue;
      if (child.programId === COMPUTE_BUDGET_PROGRAM || child.programId === ctx.programId) continue;
      if (!programs.includes(child.programId)) programs.push(child.programId);
    }
    fields.cpi = programs;
  }
  return fields;
}
