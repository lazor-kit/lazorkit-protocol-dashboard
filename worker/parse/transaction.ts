// Transaction JSON -> lk.events rows for one program (spec §6). Never throws for odd data: a parser exception
// becomes one kind=254 row flagged PARSE_ERROR (§6.8).

import bs58 from 'bs58';
import { BPF_LOADER_UPGRADEABLE, FLAGS, KIND_NOISE, KIND_NONE, LOADER_IX, MAX_IX_KIND } from '../chain/constants.js';
import type { EventRow, ParseContext, RawInstruction, RawTransaction } from '../types.js';
import { classifyFailure } from './errors.js';
import { extractFields, type DecodedIx, type TxView } from './instructions.js';

export interface ParseResult {
  rows: EventRow[];
  warnings: string[];
}

function decodeData(data: string): Uint8Array {
  if (!data) return new Uint8Array(0);
  return bs58.decode(data);
}

function kindOf(data: Uint8Array): number {
  return data.length > 0 && data[0] <= MAX_IX_KIND ? data[0] : KIND_NOISE;
}

function txVersion(version: RawTransaction['version']): number {
  if (version === undefined || version === null || version === 'legacy') return -1;
  return typeof version === 'number' ? version : -1;
}

function decodeIx(raw: RawInstruction, keys: string[]): DecodedIx {
  const programId = keys[raw.programIdIndex];
  if (programId === undefined) throw new Error(`program index ${raw.programIdIndex} out of range`);
  const accounts = raw.accounts.map((index) => {
    const key = keys[index];
    if (key === undefined) throw new Error(`account index ${index} out of range`);
    return key;
  });
  return {
    programId,
    accounts,
    accountIndexes: raw.accounts,
    data: decodeData(raw.data),
    stackHeight: typeof raw.stackHeight === 'number' ? raw.stackHeight : null,
  };
}

/** Direct children of an instruction at stack height `height` starting at position `start` of an inner list. */
function directChildren(list: DecodedIx[], start: number, height: number): DecodedIx[] {
  const children: DecodedIx[] = [];
  for (let i = start; i < list.length; i += 1) {
    const h = list[i].stackHeight;
    if (h === null) {
      if (height === 1) children.push(list[i]); // pre-stackHeight data: treat as direct children of the top level
      continue;
    }
    if (h <= height) break;
    if (h === height + 1) children.push(list[i]);
  }
  return children;
}

function loaderOp(ix: DecodedIx, programId: string): 'deploy' | 'upgrade' | 'extend' | null {
  if (ix.programId !== BPF_LOADER_UPGRADEABLE || ix.data.length < 4) return null;
  const tag = ix.data[0] | (ix.data[1] << 8) | (ix.data[2] << 16) | (ix.data[3] << 24);
  if (tag === LOADER_IX.DeployWithMaxDataLen && ix.accounts[2] === programId) return 'deploy';
  if (tag === LOADER_IX.Upgrade && ix.accounts[1] === programId) return 'upgrade';
  if ((tag === LOADER_IX.ExtendProgram || tag === 9) && ix.accounts[1] === programId) return 'extend';
  return null;
}

/**
 * @param blockTimeOverride ISO time used when tx.blockTime is null (the caller resolves it with getBlockTime).
 */
export function parseTransaction(
  tx: RawTransaction,
  ctx: ParseContext,
  signatureHint?: string,
  blockTimeOverride?: string | null,
): ParseResult {
  const warnings: string[] = [];
  const signature = tx.transaction?.signatures?.[0] ?? signatureHint;
  if (!signature) throw new Error('transaction without a signature');
  const blockTime =
    tx.blockTime !== null && tx.blockTime !== undefined
      ? new Date(tx.blockTime * 1000).toISOString()
      : blockTimeOverride ?? null;
  if (!blockTime) throw new Error(`no block time for ${signature}`);
  const meta = tx.meta;
  const ok = meta ? meta.err === null || meta.err === undefined : false;
  const base = {
    signature,
    slot: tx.slot,
    block_time: blockTime,
    ok,
    tx_version: txVersion(tx.version),
    parser_version: ctx.parserVersion,
  };

  try {
    if (!meta) throw new Error('transaction without meta');
    const message = tx.transaction.message;
    const keys = [
      ...message.accountKeys,
      ...(meta.loadedAddresses?.writable ?? []),
      ...(meta.loadedAddresses?.readonly ?? []),
    ];
    const topLevel = message.instructions.map((raw) => decodeIx(raw, keys));
    const innerByIndex = new Map<number, DecodedIx[]>();
    for (const group of meta.innerInstructions ?? []) {
      innerByIndex.set(group.index, group.instructions.map((raw) => decodeIx(raw, keys)));
    }
    const view: TxView = {
      keys,
      signers: keys.slice(0, message.header.numRequiredSignatures),
      preBalances: meta.preBalances ?? [],
      postBalances: meta.postBalances ?? [],
      topLevel,
    };

    // Is there a real instruction of the other LazorKit program of this cluster? (cluster de-duplication)
    let shared = false;
    if (ctx.otherProgramId) {
      const all = [...topLevel, ...[...innerByIndex.values()].flat()];
      shared = all.some((ix) => ix.programId === ctx.otherProgramId && kindOf(ix.data) <= MAX_IX_KIND);
    }

    const failure = classifyFailure(
      meta.err,
      (index) => topLevel[index]?.programId === ctx.programId,
      (index) => {
        const ix = topLevel[index];
        return !ix || kindOf(ix.data) === KIND_NOISE;
      },
    );

    const rows: EventRow[] = [];
    const push = (ix: DecodedIx, topIndex: number, inner: boolean, children: DecodedIx[]) => {
      const kind = kindOf(ix.data);
      const fields = extractFields(kind, ix, children, view, topIndex, inner, ok, ctx);
      rows.push({
        ...base,
        ix_seq: rows.length,
        kind,
        top_ix: topIndex,
        inner_ix: inner,
        fail_class: failure.failClass,
        err_code: failure.errCode,
        ...fields,
        net_fee_lamports: null,
        shared,
      });
    };

    topLevel.forEach((ix, i) => {
      const inner = innerByIndex.get(i) ?? [];
      if (ix.programId === ctx.programId) push(ix, i, false, directChildren(inner, 0, 1));
      inner.forEach((child, position) => {
        if (child.programId !== ctx.programId) return;
        const height = child.stackHeight ?? 2;
        push(child, i, true, directChildren(inner, position + 1, height));
      });
    });

    if (rows.length === 0) {
      let flags = 0;
      let ref: string | null = null;
      for (const ix of topLevel) {
        const op = loaderOp(ix, ctx.programId);
        if (!op) continue;
        flags |= FLAGS.LOADER_OP;
        if (op === 'deploy') flags |= FLAGS.HISTORY_START;
        ref = ref ?? op;
      }
      rows.push({
        ...base,
        ix_seq: 0,
        kind: KIND_NONE,
        top_ix: null,
        inner_ix: false,
        fail_class: ok ? null : 'noise',
        err_code: failure.errCode,
        wallet: null,
        payer: null,
        auth: null,
        fee_lamports: 0,
        amount_lamports: null,
        tokens: null,
        ref,
        app: null,
        cpi: null,
        shared,
        flags,
        net_fee_lamports: null,
      });
    } else if (!ok && !rows.some((row) => row.kind <= MAX_IX_KIND)) {
      // A failed transaction without real LazorKit activity (program-ping bots) is noise, whatever failed.
      for (const row of rows) row.fail_class = 'noise';
    }
    // Failed inside an instruction: that instruction belongs to at most one LazorKit program, which lets the
    // cluster total of a transaction shared by v1 and v2 keep the failing program's class (lk.rollup).
    if (failure.instructionIndex !== null) for (const row of rows) row.flags |= FLAGS.IX_ERROR;
    rows[0].net_fee_lamports = meta.fee ?? null;
    return { rows, warnings };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`parse error in ${signature}: ${message}`);
    return {
      rows: [
        {
          ...base,
          ix_seq: 0,
          kind: KIND_NOISE,
          top_ix: null,
          inner_ix: false,
          fail_class: ok ? null : 'other',
          err_code: null,
          wallet: null,
          payer: null,
          auth: null,
          fee_lamports: 0,
          amount_lamports: null,
          tokens: null,
          ref: null,
          app: null,
          cpi: null,
          tx_version: base.tx_version,
          net_fee_lamports: meta?.fee ?? null,
          shared: false,
          flags: FLAGS.PARSE_ERROR,
        },
      ],
      warnings,
    };
  }
}
