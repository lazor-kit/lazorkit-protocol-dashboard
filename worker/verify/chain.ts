// R2: chain recomputation check (spec §14.4), `npm run verify:chain` (also mode=verify in Actions).
// 1. pages each live program's FULL signature history from the archival endpoint;
// 2. counts signatures and failed signatures per UTC day, up to the build's frontier slot;
// 3. compares them with lk.daily (sealed days included, so this is exact for all history);
// 4. takes an independent getProgramAccounts snapshot and compares account counts with state_current
//    (informational when the slots differ: new activity can land in between) and prints the I1-I6 results.
// Exit 1 on any per-day mismatch.

import { loadApiEnv } from '../../scripts/loadApiEnv.js';
import { PROGRAMS } from '../../src/types/protocol.js';
import { isPublicEndpoint, PUBLIC_RATES, PUBLIC_RPC } from '../config.js';
import { PostgrestLkDb } from '../db/client.js';
import { redactText, RpcClient } from '../rpc/client.js';
import { takeSnapshot } from '../state/snapshot.js';
import type { SignatureInfo } from '../types.js';

interface VerifyCounts {
  programKey: number;
  gen: number;
  deployStatus: string;
  frontierSlot: number | null;
  backfillComplete: boolean;
  pending: number;
  stateSlot: number | null;
  state: Record<string, unknown> | null;
  checks: Array<{ id: string; ok: boolean | null; mode: string; expected: string | null; actual: string | null }>;
  days: Array<{ day: string; sigs: number; sigsFailed: number }>;
}

export interface DayDiff {
  day: string;
  chainSigs: number;
  chainFailed: number;
  dbSigs: number;
  dbFailed: number;
}

/** Per-day comparison of the chain's signature list (newest first) with lk.daily, up to the frontier slot. */
export function compareDays(chain: SignatureInfo[], frontierSlot: number, days: VerifyCounts['days']): { diffs: DayDiff[]; chainTotal: number; dbTotal: number } {
  const chainDays = new Map<string, { sigs: number; failed: number }>();
  let chainTotal = 0;
  for (const signature of chain) {
    if (signature.slot > frontierSlot || signature.blockTime === null) continue;
    const day = new Date(signature.blockTime * 1000).toISOString().slice(0, 10);
    const entry = chainDays.get(day) ?? { sigs: 0, failed: 0 };
    entry.sigs += 1;
    if (signature.err !== null && signature.err !== undefined) entry.failed += 1;
    chainDays.set(day, entry);
    chainTotal += 1;
  }
  const dbDays = new Map(days.map((d) => [d.day.slice(0, 10), d]));
  const diffs: DayDiff[] = [];
  for (const day of new Set([...chainDays.keys(), ...dbDays.keys()])) {
    const c = chainDays.get(day) ?? { sigs: 0, failed: 0 };
    const d = dbDays.get(day) ?? { sigs: 0, sigsFailed: 0 };
    if (c.sigs !== d.sigs || c.failed !== d.sigsFailed) {
      diffs.push({ day, chainSigs: c.sigs, chainFailed: c.failed, dbSigs: d.sigs, dbFailed: d.sigsFailed });
    }
  }
  diffs.sort((a, b) => a.day.localeCompare(b.day));
  return { diffs, chainTotal, dbTotal: days.reduce((sum, d) => sum + d.sigs, 0) };
}

async function fullHistory(rpc: RpcClient, programId: string): Promise<SignatureInfo[]> {
  const all: SignatureInfo[] = [];
  let before: string | undefined;
  for (;;) {
    const options: Record<string, unknown> = { limit: 1000, commitment: 'finalized' };
    if (before) options.before = before;
    const page = await rpc.call<SignatureInfo[]>('getSignaturesForAddress', [programId, options]);
    all.push(...page);
    if (page.length < 1000) return all;
    before = page[page.length - 1].signature;
  }
}

async function main(): Promise<number> {
  loadApiEnv();
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
    return 2;
  }
  const secrets = [key];
  const archival = {
    mainnet: process.env.MAINNET_ARCHIVE_RPC_URL?.trim() || PUBLIC_RPC.mainnet,
    devnet: process.env.DEVNET_ARCHIVE_RPC_URL?.trim() || PUBLIC_RPC.devnet,
  };
  for (const value of Object.values(archival)) if (!isPublicEndpoint(value)) secrets.push(value);
  const log = (line: string) => console.log(redactText(line, secrets));
  const db = new PostgrestLkDb(url, key);
  const clients = {
    mainnet: new RpcClient({ url: archival.mainnet, heavyRps: PUBLIC_RATES.heavy, lightRps: PUBLIC_RATES.light, log }),
    devnet: new RpcClient({ url: archival.devnet, heavyRps: PUBLIC_RATES.heavy, lightRps: PUBLIC_RATES.light, log }),
  };
  let mismatches = 0;
  const rows: string[] = [];
  for (const program of PROGRAMS) {
    const counts = await db.rpc<VerifyCounts>('lk_verify_counts', { p_program: program.programKey });
    if (counts.deployStatus !== 'live') {
      log(`[verify] ${program.label}: ${counts.deployStatus}, skipped`);
      continue;
    }
    if (!counts.backfillComplete || counts.pending > 0 || counts.frontierSlot === null) {
      log(`[verify] ${program.label}: not comparable yet (backfill ${counts.backfillComplete}, pending ${counts.pending})`);
      mismatches += 1;
      continue;
    }
    const rpc = clients[program.cluster];
    const chain = await fullHistory(rpc, program.programId);
    const result = compareDays(chain, counts.frontierSlot, counts.days);
    mismatches += result.diffs.length;
    rows.push(`| ${program.label} | ${counts.frontierSlot} | ${result.chainTotal} | ${result.dbTotal} | ${counts.days.length} | ${result.diffs.length} |`);
    for (const diff of result.diffs) log(`[verify] ${program.label} ${JSON.stringify(diff)}`);

    const fresh = await takeSnapshot(rpc, program.programId, program.version);
    const stored = (counts.state ?? {}) as Record<string, any>;
    const pick = (t: Record<string, any>) => ({
      accounts: t.accounts, wallets: t.wallets, authorities: t.authorities?.total, sessions: t.sessions?.total,
      deferred: t.deferred?.total, feeRecords: t.feeRecords?.count, shards: t.treasury?.shards,
    });
    const a = pick(fresh.totals as unknown as Record<string, any>);
    const b = pick(stored);
    const same = JSON.stringify(a) === JSON.stringify(b);
    log(`[verify] ${program.label} state: fresh @${fresh.slot} ${JSON.stringify(a)} vs stored @${counts.stateSlot} ` +
      `${JSON.stringify(b)} -> ${same ? 'identical' : 'differs (informational: activity after the stored snapshot)'}`);
    const checks = counts.checks.map((c) => `${c.id}:${c.mode === 'pending' ? 'pending' : c.ok ? 'ok' : `MISMATCH(${c.expected} vs ${c.actual})`}`);
    log(`[verify] ${program.label} invariants: ${checks.join(' ')}`);
  }
  console.log(['', '| program | frontier slot | chain signatures | db signatures | days | day mismatches |', '| --- | ---: | ---: | ---: | ---: | ---: |', ...rows].join('\n'));
  console.log(`verify:chain: ${mismatches === 0 ? 'OK, 0 mismatches' : `${mismatches} mismatches`}`);
  return mismatches === 0 ? 0 : 1;
}

if (process.argv[1]?.endsWith('chain.ts') || process.argv[1]?.endsWith('chain.js')) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
