// An independent TypeScript implementation of the per-day flow metrics (spec §8.1), written from the spec rather
// than from the SQL, so the integration test can check that lk.daily (SQL) and this agree on real parsed rows.

import type { EventRow } from '../types.js';

const WALLET_KINDS = new Set([0, 1, 2, 3, 4, 5, 6, 7, 9, 17]);
const PAYER_KINDS = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 17, 18]);
const AUTH_NAMES: Record<number, string> = { 1: 'passkey', 2: 'session', 3: 'ed25519', 4: 'deferred' };

export interface ReferenceDay {
  sigs: number;
  sigs_failed: number;
  txs: number;
  txs_ok: number;
  txs_failed: number;
  noise_txs: number;
  unparsed_txs: number;
  ixs: number;
  inner_ixs: number;
  wallets_created: number;
  wallets_created_passkey: number;
  active_wallets: number;
  payers: number;
  executes: number;
  fee_lamports: number;
  fee_events: number;
  fee_eligible_ok: number;
  fee_suffix_ok: number;
  shard_funding_lamports: number;
  withdrawn_lamports: number;
  net_fee_lamports: number;
  migrations: number;
  migrated_lamports: number;
  migrated_tokens: number;
  cleanup_lamports: number;
  retired_calls: number;
  txv1: number;
  shared_txs: number;
  by_kind: Record<string, { ok: number; fail: number }>;
  by_auth: Record<string, number>;
  by_fail: Record<string, number>;
}

function bump(map: Record<string, number>, key: string, by = 1) {
  map[key] = (map[key] ?? 0) + by;
}

export function referenceRollup(rows: EventRow[]): Map<string, ReferenceDay> {
  const byDay = new Map<string, EventRow[]>();
  for (const row of rows) {
    const day = new Date(row.block_time).toISOString().slice(0, 10);
    const list = byDay.get(day) ?? [];
    list.push(row);
    byDay.set(day, list);
  }
  const out = new Map<string, ReferenceDay>();
  for (const [day, dayRows] of byDay) {
    const bySignature = new Map<string, EventRow[]>();
    for (const row of dayRows) {
      const list = bySignature.get(row.signature) ?? [];
      list.push(row);
      bySignature.set(row.signature, list);
    }
    const d: ReferenceDay = {
      sigs: 0, sigs_failed: 0, txs: 0, txs_ok: 0, txs_failed: 0, noise_txs: 0, unparsed_txs: 0, ixs: 0, inner_ixs: 0,
      wallets_created: 0, wallets_created_passkey: 0, active_wallets: 0, payers: 0, executes: 0, fee_lamports: 0,
      fee_events: 0, fee_eligible_ok: 0, fee_suffix_ok: 0, shard_funding_lamports: 0, withdrawn_lamports: 0,
      net_fee_lamports: 0, migrations: 0, migrated_lamports: 0, migrated_tokens: 0, cleanup_lamports: 0,
      retired_calls: 0, txv1: 0, shared_txs: 0, by_kind: {}, by_auth: {}, by_fail: {},
    };
    const wallets = new Set<string>();
    const payers = new Set<string>();
    for (const txRows of bySignature.values()) {
      const ok = txRows[0].ok;
      const real = txRows.some((r) => r.kind <= 18);
      d.sigs += 1;
      if (!ok) d.sigs_failed += 1;
      if (real) {
        d.txs += 1;
        if (ok) d.txs_ok += 1;
        else {
          d.txs_failed += 1;
          bump(d.by_fail, txRows[0].fail_class ?? 'other');
          if (txRows[0].fail_class === 'retired') d.retired_calls += 1;
        }
        if (txRows.some((r) => r.tx_version === 1)) d.txv1 += 1;
        if (txRows.some((r) => r.shared)) d.shared_txs += 1;
        d.net_fee_lamports += Math.max(...txRows.map((r) => r.net_fee_lamports ?? 0));
      } else if (txRows.some((r) => r.kind === 253)) {
        d.unparsed_txs += 1;
      } else {
        d.noise_txs += 1;
      }
      for (const r of txRows) {
        if (r.kind <= 18) {
          d.ixs += 1;
          if (r.inner_ix) d.inner_ixs += 1;
          const entry = d.by_kind[String(r.kind)] ?? { ok: 0, fail: 0 };
          if (r.ok) entry.ok += 1;
          else entry.fail += 1;
          d.by_kind[String(r.kind)] = entry;
        }
        if (!r.ok) continue;
        if (r.kind === 0) {
          d.wallets_created += 1;
          if (r.auth === 1) d.wallets_created_passkey += 1;
        }
        if (WALLET_KINDS.has(r.kind) && r.wallet) wallets.add(r.wallet);
        if (PAYER_KINDS.has(r.kind) && r.payer) payers.add(r.payer);
        if (r.kind === 4) d.executes += 1;
        if (r.kind === 4 || r.kind === 7) bump(d.by_auth, r.auth ? AUTH_NAMES[r.auth] : 'unknown');
        if (r.kind === 0 || r.kind === 4 || r.kind === 7) {
          d.fee_eligible_ok += 1;
          d.fee_lamports += r.fee_lamports;
          if (r.fee_lamports > 0) d.fee_events += 1;
          if (r.flags & 16) d.fee_suffix_ok += 1;
        }
        if (r.kind === 14) d.shard_funding_lamports += r.amount_lamports ?? 0;
        if (r.kind === 13) d.withdrawn_lamports += r.amount_lamports ?? 0;
        if (r.kind === 17) {
          d.migrations += 1;
          d.migrated_lamports += r.amount_lamports ?? 0;
          d.migrated_tokens += r.tokens ?? 0;
        }
        if (r.kind === 8 || r.kind === 18) d.cleanup_lamports += r.amount_lamports ?? 0;
      }
    }
    d.active_wallets = wallets.size;
    d.payers = payers.size;
    out.set(day, d);
  }
  return out;
}
