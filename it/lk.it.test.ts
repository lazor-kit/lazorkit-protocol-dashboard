// Integration tests through a LOCAL Supabase (PostgREST over HTTP; psql only for fingerprints and cleanup).
// Run: npx supabase start && npx supabase db reset, then
//   eval "$(npx supabase status -o env | sed 's/^/export LOCAL_/')"
//   SUPABASE_URL=$LOCAL_API_URL SUPABASE_SERVICE_ROLE_KEY=$LOCAL_SERVICE_ROLE_KEY SUPABASE_ANON_KEY=$LOCAL_ANON_KEY npm run test:it
// They work on program 2 (v2 mainnet, not deployed: no real data) and clean it up afterwards.
// Never point these at a hosted project.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dashboardFromRaw, type RawDashboard } from '../api/_lib/payload.js';
import { validateDashboardPayload } from '../src/types/validate.js';
import { innerCreateWallet, migrateWallet, withdrawTreasury } from '../worker/__fixtures__/synthetic/index.js';
import { parseContextFor } from '../worker/chain/pdas.js';
import { PostgrestLkDb, DbError } from '../worker/db/client.js';
import { parseTransaction } from '../worker/parse/transaction.js';
import { FIXTURE_SIGNATURES, fixturePath } from '../worker/scripts/fetchFixtures.js';
import type { EventRow, RawTransaction } from '../worker/types.js';
import { referenceRollup } from '../worker/verify/referenceRollup.js';

const enabled = process.env.LK_IT === '1';
const url = process.env.SUPABASE_URL ?? '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? '';
const dbUrl = process.env.LK_IT_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const P = 2; // v2 mainnet: not deployed, so it holds no real data

function sql(query: string): string {
  return execFileSync('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1', '-Atqc', query], { encoding: 'utf8' }).trim();
}

function resetProgram() {
  sql(`delete from lk.events where program_key = ${P}; delete from lk.daily where program_key = ${P};
       delete from lk.actor_days where program_key = ${P}; delete from lk.wallets where program_key = ${P};
       delete from lk.pending where program_key = ${P}; delete from lk.gaps where program_key = ${P};
       delete from lk.deploys where program_key = ${P};
       update lk.programs set active_gen = 1, checks = '[]' where program_key = ${P};
       delete from lk.builds where program_key = ${P} and gen > 1;
       update lk.builds set status = 'active', frontier_slot = null, frontier_signature = null, frontier_block_time = null,
         discovered_at = null, history_end_reached = false, history_start_signature = null, history_proof = null,
         backfill_complete = false, backfill_completed_at = null, first_activity_at = null, ingested_sigs = 0,
         compacted_before = null where program_key = ${P} and gen = 1;`);
}

function fingerprint(): string {
  return sql(`select md5(
    coalesce((select string_agg((to_jsonb(d) - 'computed_at')::text, '|' order by d.gen, d.day) from lk.daily d where d.program_key = ${P}), '') ||
    coalesce((select string_agg(a.gen || a.day::text || a.role || a.actor, '|' order by 1) from lk.actor_days a where a.program_key = ${P}), '') ||
    coalesce((select string_agg(to_jsonb(w)::text, '|' order by w.gen, w.wallet) from lk.wallets w where w.program_key = ${P}), ''))`);
}

/** Real parsed rows: every v1 mainnet fixture plus the synthetic ones, grouped per signature. */
function parsedBatches(): Array<{ signature: string; rows: EventRow[] }> {
  const ctx = parseContextFor(1);
  const txs: RawTransaction[] = Object.values(FIXTURE_SIGNATURES['mainnet-1']).map(
    (signature) => JSON.parse(readFileSync(fixturePath('mainnet-1', signature), 'utf8')) as RawTransaction,
  );
  txs.push(withdrawTreasury(), migrateWallet().tx, innerCreateWallet().tx);
  return txs
    .map((tx) => {
      const { rows } = parseTransaction(tx, ctx);
      return { signature: rows[0].signature, rows };
    })
    .sort((a, b) => a.rows[0].slot - b.rows[0].slot || a.signature.localeCompare(b.signature));
}

async function anonRpc(fn: string, args: Record<string, unknown>) {
  const response = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: anonKey, authorization: `Bearer ${anonKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  return { status: response.status, body: (await response.json().catch(() => null)) as Record<string, unknown> | null };
}

describe.skipIf(!enabled)('integration: local PostgREST', () => {
  const db = new PostgrestLkDb(url, serviceKey);
  const batches = enabled ? parsedBatches() : [];

  async function load(order: Array<Array<{ signature: string; rows: EventRow[] }>>) {
    for (const group of order) {
      await db.ingest(P, 1, group.flatMap((b) => b.rows), group.map((b) => b.signature));
    }
  }

  beforeAll(() => resetProgram());
  afterAll(() => resetProgram());

  it('G1 with the real anon key: readers work, writers and the lk schema are closed', async () => {
    expect((await anonRpc('lk_dashboard', { p_cluster: 'mainnet', p_window: '7d' })).status).toBe(200);
    expect((await anonRpc('lk_schema_version', {})).status).toBe(200);
    const denied = await anonRpc('lk_ingest', { p_program: P, p_gen: 1, p_events: [], p_signatures: [] });
    expect([401, 403]).toContain(denied.status);
    expect(denied.body?.code).toBe('42501');
    const table = await fetch(`${url}/rest/v1/events?select=*`, { headers: { apikey: anonKey, authorization: `Bearer ${anonKey}` } });
    expect(table.status).toBe(404);
  });

  it('integer parameters go over HTTP as JSON numbers (no smallint overload trouble)', async () => {
    const context = await db.workerContext();
    expect(context.schemaVersion).toBe(1);
    expect((await db.pending(P, 1, 5, 'it-run')).length).toBe(0);
  });

  it('P1-P3 with real parsed rows: replays, overlapping batches and reverse order give identical state', async () => {
    expect(batches.length).toBeGreaterThan(15);
    resetProgram();
    const chunks = (size: number) => Array.from({ length: Math.ceil(batches.length / size) }, (_, i) => batches.slice(i * size, i * size + size));
    await load(chunks(5));
    const reference = fingerprint();
    await load(chunks(5));
    expect(fingerprint()).toBe(reference);
    resetProgram();
    const overlapping: typeof batches[] = [];
    for (let i = 0; i < batches.length; i += 4) overlapping.push(batches.slice(i, i + 7));
    await load(overlapping);
    expect(fingerprint()).toBe(reference);
    resetProgram();
    await load(chunks(3).reverse());
    expect(fingerprint()).toBe(reference);
    resetProgram();
    await load(batches.map((b) => [b]).reverse());
    expect(fingerprint()).toBe(reference);
    expect(Number(sql(`select (public.lk_verify(${P}, 1) ->> 'mismatches')`))).toBe(0);
  });

  it('the TypeScript reference rollup equals the SQL daily rows and the lk_dashboard KPIs', async () => {
    resetProgram();
    await load(batches.map((b) => [b]));
    const reference = referenceRollup(batches.flatMap((b) => b.rows));
    const stored = JSON.parse(sql(`select coalesce(jsonb_object_agg(day, to_jsonb(d)), '{}') from lk.daily d where program_key = ${P} and gen = 1`)) as
      Record<string, Record<string, unknown>>;
    expect(Object.keys(stored).sort()).toEqual([...reference.keys()].sort());
    for (const [day, ref] of reference) {
      const row = stored[day];
      for (const [key, value] of Object.entries(ref)) {
        if (key === 'by_kind' || key === 'by_auth' || key === 'by_fail') {
          expect(row[key], `${day}.${key}`).toEqual(value);
        } else {
          expect(Number(row[key]), `${day}.${key}`).toBe(value);
        }
      }
    }
    const raw = await db.rpc<RawDashboard>('lk_dashboard', { p_cluster: 'mainnet', p_window: 'all' });
    const kpis = raw.kpis['2']?.current;
    const sum = (key: string) =>
      [...reference.values()].reduce((total, d) => total + Number((d as unknown as Record<string, number>)[key]), 0);
    expect(kpis?.txs).toBe(sum('txs'));
    expect(kpis?.signatures).toBe(sum('sigs'));
    expect(kpis?.txsFailed).toBe(sum('txs_failed'));
    expect(kpis?.walletsCreated).toBe(sum('wallets_created'));
    expect(kpis?.executes).toBe(sum('executes'));
    expect(kpis?.feeLamports).toBe(String(sum('fee_lamports')));
    expect(kpis?.migrations).toBe(sum('migrations'));
    expect(kpis?.withdrawnLamports).toBe(String(sum('withdrawn_lamports')));
    const allWallets = new Set(batches.flatMap((b) => b.rows).filter((r) => r.ok && r.wallet && [0, 1, 2, 3, 4, 5, 6, 7, 9, 17].includes(r.kind)).map((r) => r.wallet));
    expect(kpis?.activeWallets).toBe(allWallets.size);
  });

  it('lk_start_build / lk_promote_build over HTTP switch generations atomically', async () => {
    resetProgram();
    await load([batches.slice(0, 6)]);
    await db.enqueue(P, 1, [], { frontier_slot: 1, frontier_signature: null, frontier_block_time: null, discovered_at: new Date(Date.now() - 60_000).toISOString(), history_end: true });
    const before = (await db.rpc<RawDashboard>('lk_dashboard', { p_cluster: 'mainnet', p_window: 'all' })).kpis['2']?.current;
    const gen = await db.startBuild(P, 2);
    expect(gen).toBe(2);
    await expect(db.startBuild(P, 2)).rejects.toBeInstanceOf(DbError);
    await db.ingest(P, gen, batches.slice(0, 6).flatMap((b) => b.rows), batches.slice(0, 6).map((b) => b.signature));
    await expect(db.promoteBuild(P, gen)).rejects.toThrow('has not finished its backfill');
    // the dashboard still serves generation 1 meanwhile
    expect((await db.rpc<RawDashboard>('lk_dashboard', { p_cluster: 'mainnet', p_window: 'all' })).kpis['2']?.current).toEqual(before);
    await db.enqueue(P, gen, [], { frontier_slot: 1, frontier_signature: null, frontier_block_time: null, discovered_at: new Date().toISOString(), history_end: true });
    await db.promoteBuild(P, gen);
    expect(sql(`select active_gen from lk.programs where program_key = ${P}`)).toBe('2');
    expect(sql(`select count(*) from lk.events where program_key = ${P} and gen = 1`)).toBe('0');
    expect((await db.rpc<RawDashboard>('lk_dashboard', { p_cluster: 'mainnet', p_window: 'all' })).kpis['2']?.current).toEqual(before);
  });

  it('every lk_dashboard payload (2 clusters x 4 windows) passes the contract validator', async () => {
    for (const cluster of ['mainnet', 'devnet'] as const) {
      for (const window of ['24h', '7d', '30d', 'all'] as const) {
        const raw = await db.rpc<RawDashboard>('lk_dashboard', { p_cluster: cluster, p_window: window });
        const payload = dashboardFromRaw(raw, new Date());
        expect(validateDashboardPayload(payload), `${cluster} ${window}`).toEqual([]);
      }
    }
  });
});
