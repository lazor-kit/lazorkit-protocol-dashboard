// Discovery and the durable queue (spec §5.3). Pages getSignaturesForAddress from the newest signature down to
// the build's frontier slot and queues everything it finds; ingestion drains the queue later, oldest first.
//
// Rules:
// - A stored signature is never sent to an RPC. `until` is never used. `before` is only ever a signature that
//   one of THIS run's calls returned.
// - A short page from the primary endpoint is never trusted as the end of history: discovery continues on the
//   archival endpoint. Only the archival endpoint can end history.
// - Discovery stops at slot < frontier; signatures in the frontier slot itself are collected again and dropped
//   by lk_enqueue (already in events or pending).
// - The frontier moves only in the final lk_enqueue call, after every older signature is durably queued.

import type { DbBuild, DiscoveryFinal, LkDb, QueuedSignature } from '../db/client.js';
import { RpcError, type RpcClient } from '../rpc/client.js';
import type { SignatureInfo } from '../types.js';

export const PAGE_LIMIT = 1000;
/** First page of an incremental pass: a quiet program costs one small call. */
export const FIRST_PAGE_LIMIT = 100;
const ENQUEUE_CHUNK = 1000;

export interface DiscoveryResult {
  found: number;
  queued: number;
  pending: number;
  pages: number;
  historyEnd: boolean;
  usedArchival: boolean;
  frontierSlot: number | null;
}

export interface DiscoverDeps {
  primary: RpcClient;
  archival: RpcClient;
  db: LkDb;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

async function page(rpc: RpcClient, programId: string, before: string | undefined, limit: number): Promise<SignatureInfo[]> {
  const options: Record<string, unknown> = { limit, commitment: 'finalized' };
  if (before) options.before = before;
  return rpc.call<SignatureInfo[]>('getSignaturesForAddress', [programId, options]);
}

function isNotFound(error: unknown): boolean {
  return error instanceof RpcError && /not found|-32009|-32007/i.test(`${error.message} ${error.code ?? ''}`);
}

export async function discover(
  deps: DiscoverDeps,
  programKey: number,
  programId: string,
  build: Pick<DbBuild, 'gen' | 'frontierSlot'>,
): Promise<DiscoveryResult> {
  const log = deps.log ?? (() => undefined);
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const t0 = (deps.now?.() ?? new Date()).toISOString();
  const frontier = build.frontierSlot;
  const found = new Map<string, SignatureInfo>();
  const order: SignatureInfo[] = [];
  let endpoint = deps.primary;
  let before: string | undefined;
  let limit = frontier === null ? PAGE_LIMIT : FIRST_PAGE_LIMIT;
  let historyEnd = false;
  let pages = 0;
  let usedArchival = false; // true only when a distinct archival endpoint had to continue the paging
  let oldestSeen: SignatureInfo | null = null;
  let continuityFloor: number | null = null;

  for (;;) {
    let result: SignatureInfo[];
    try {
      result = await page(endpoint, programId, before, limit);
    } catch (error) {
      if (endpoint === deps.archival && before && isNotFound(error)) {
        // the archival endpoint may lag on a `before` taken from the primary: retry, then restart from the top
        let recovered: SignatureInfo[] | null = null;
        for (let attempt = 0; attempt < 3 && !recovered; attempt += 1) {
          await sleep(2000);
          try {
            recovered = await page(endpoint, programId, before, limit);
          } catch (retryError) {
            if (!isNotFound(retryError)) throw retryError;
          }
        }
        if (!recovered) {
          log(`[discover ${programKey}] archival does not know ${before.slice(0, 8)}…; restarting archival paging`);
          before = undefined;
          limit = PAGE_LIMIT;
          // the restarted pages must overlap what was already collected, or signatures could be skipped
          continuityFloor = oldestSeen?.slot ?? null;
          continue;
        }
        result = recovered;
      } else {
        throw error;
      }
    }
    pages += 1;
    if (continuityFloor !== null) {
      if (result.length > 0 && result[0].slot < continuityFloor) {
        throw new Error(
          `archival endpoint lags behind the primary (newest archival slot ${result[0].slot} < ${continuityFloor}); retry later`,
        );
      }
      continuityFloor = null;
    }
    let reachedFrontier = false;
    for (const signature of result) {
      if (frontier !== null && signature.slot < frontier) {
        reachedFrontier = true;
        break;
      }
      if (!found.has(signature.signature)) {
        found.set(signature.signature, signature);
        order.push(signature);
      }
      oldestSeen = signature;
    }
    if (reachedFrontier) break;
    if (result.length < limit) {
      if (endpoint !== deps.archival) {
        endpoint = deps.archival;
        usedArchival = true;
        before = result.length > 0 ? result[result.length - 1].signature : before;
        limit = PAGE_LIMIT;
        continue;
      }
      if (frontier !== null) {
        // History ended on the archival endpoint without passing below the frontier. That is only fine when the
        // frontier slot itself is the start of history (we collected it again).
        if (!oldestSeen || oldestSeen.slot > frontier) {
          throw new Error(
            `archival history ended above the frontier (frontier slot ${frontier}, oldest seen ${oldestSeen?.slot ?? 'none'})`,
          );
        }
        break;
      }
      historyEnd = true;
      break;
    }
    before = result[result.length - 1].signature;
    limit = PAGE_LIMIT;
  }

  // resolve missing block times (rare) with getBlockTime, one call per distinct slot
  const slotTimes = new Map<number, number>();
  for (const signature of order) {
    if (signature.blockTime !== null && signature.blockTime !== undefined) continue;
    if (!slotTimes.has(signature.slot)) {
      let seconds: number | null = null;
      for (const client of endpoint === deps.primary ? [deps.primary] : [deps.primary, deps.archival]) {
        try {
          seconds = await client.call<number | null>('getBlockTime', [signature.slot]);
          if (typeof seconds === 'number') break;
        } catch {
          seconds = null;
        }
      }
      if (typeof seconds !== 'number') throw new Error(`no block time for slot ${signature.slot}`);
      slotTimes.set(signature.slot, seconds);
    }
    signature.blockTime = slotTimes.get(signature.slot) ?? null;
  }

  const rows: QueuedSignature[] = order.map((signature) => ({
    signature: signature.signature,
    slot: signature.slot,
    block_time: new Date((signature.blockTime as number) * 1000).toISOString(),
    err: signature.err ?? null,
  }));
  let queued = 0;
  for (let i = 0; i < rows.length; i += ENQUEUE_CHUNK) {
    const result = await deps.db.enqueue(programKey, build.gen, rows.slice(i, i + ENQUEUE_CHUNK), null);
    queued += result.queued;
  }
  const newest = order[0] ?? null;
  const final: DiscoveryFinal = {
    frontier_slot: newest?.slot ?? null,
    frontier_signature: newest?.signature ?? null,
    frontier_block_time: newest ? new Date((newest.blockTime as number) * 1000).toISOString() : null,
    discovered_at: t0,
    history_end: historyEnd,
  };
  const last = await deps.db.enqueue(programKey, build.gen, [], final);
  const pending = last.pending;
  log(
    `[discover ${programKey}/g${build.gen}] ${order.length} signatures seen (${queued} new) in ${pages} page(s)` +
      `${usedArchival ? ' incl. archival' : ''}; frontier ${frontier ?? 'none'} -> ${newest?.slot ?? frontier ?? 'none'}` +
      `${historyEnd ? '; history start reached' : ''}; pending ${pending}`,
  );
  return {
    found: order.length,
    queued,
    pending,
    pages,
    historyEnd,
    usedArchival,
    frontierSlot: newest?.slot ?? frontier,
  };
}
