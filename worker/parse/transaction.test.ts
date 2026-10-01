// Parser tests on real transactions (worker/__fixtures__/tx, fetched read-only; `npm run fixtures:fetch`) and on
// labelled synthetic ones for cases never seen on chain (worker/__fixtures__/synthetic).

import { readFileSync } from 'node:fs';
import { FLAGS } from '../chain/constants.js';
import { parseContextFor } from '../chain/pdas.js';
import { FIXTURE_SIGNATURES, fixturePath } from '../scripts/fetchFixtures.js';
import { innerCreateWallet, migrateWallet, withdrawTreasury } from '../__fixtures__/synthetic/index.js';
import type { EventRow, RawTransaction } from '../types.js';
import { parseTransaction } from './transaction.js';

type Dir = keyof typeof FIXTURE_SIGNATURES;
const PROGRAM_KEY: Record<Dir, number> = { 'mainnet-1': 1, 'devnet-3': 3, 'devnet-4': 4 };
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SYSTEM = '11111111111111111111111111111111';

function load<D extends Dir>(dir: D, name: keyof (typeof FIXTURE_SIGNATURES)[D] & string): RawTransaction {
  const signature = (FIXTURE_SIGNATURES[dir] as Record<string, string>)[name];
  return JSON.parse(readFileSync(fixturePath(dir, signature), 'utf8')) as RawTransaction;
}

function parse<D extends Dir>(dir: D, name: keyof (typeof FIXTURE_SIGNATURES)[D] & string): { rows: EventRow[]; tx: RawTransaction } {
  const tx = load(dir, name);
  const result = parseTransaction(tx, parseContextFor(PROGRAM_KEY[dir]));
  expect(result.warnings).toEqual([]);
  return { rows: result.rows, tx };
}

/** The resolved accounts of the first top-level instruction of `programId`. */
function ixAccounts(tx: RawTransaction, programId: string, nth = 0): string[] {
  const keys = [
    ...tx.transaction.message.accountKeys,
    ...(tx.meta?.loadedAddresses?.writable ?? []),
    ...(tx.meta?.loadedAddresses?.readonly ?? []),
  ];
  const ixs = tx.transaction.message.instructions.filter((ix) => keys[ix.programIdIndex] === programId);
  return ixs[nth].accounts.map((index) => keys[index]);
}

const V1_MAINNET = 'LazorjRFNavitUaBu5m3WaNPjU1maipvSW2rZfAFAKi';

describe('parser: v1 mainnet', () => {
  it('passkey CreateWallet with the Seedless rpId pays the 5,000 lamport fee', () => {
    const { rows, tx } = parse('mainnet-1', 'createWalletPasskeySeedless');
    const acc = ixAccounts(tx, V1_MAINNET);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 0, ix_seq: 0, ok: true, wallet: acc[1], ref: acc[2], payer: acc[0], auth: 1,
      app: 'www.seedlesslabs.xyz', fee_lamports: 5000, tx_version: 0, inner_ix: false, top_ix: 0, net_fee_lamports: 5000 });
    expect(rows[0].flags & FLAGS.FEE_SUFFIX).toBeTruthy();
  });

  it('session Execute: signer class session (PDA match), CPIs, fee', () => {
    const { rows } = parse('mainnet-1', 'executeSession');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 4, auth: 2, fee_lamports: 5000 });
    // The spec table expects cpi ⊇ {System, SPL Token}; per its own rule (§6.3: the fee transfer is excluded)
    // the only System child here IS the fee transfer, so the vault's programs are SPL Token alone.
    expect(rows[0].cpi).toEqual([TOKEN]);
  });

  it('passkey Execute: precompile at i-1, app from clientDataJSON', () => {
    const { rows } = parse('mainnet-1', 'executePasskey');
    expect(rows[0]).toMatchObject({ kind: 4, auth: 1, app: 'www.seedlesslabs.xyz' });
    expect(rows[0].flags & FLAGS.NO_CDJ).toBe(0);
  });

  it('Execute without the fee suffix whose vault pays the payer books fee 0 (3d9XBfek)', () => {
    const { rows } = parse('mainnet-1', 'executeNoSuffixVaultToPayer');
    expect(rows[0]).toMatchObject({ kind: 4, ok: true, fee_lamports: 0 });
    expect(rows[0].flags & FLAGS.FEE_SUFFIX).toBe(0);
    expect(rows[0].cpi).toEqual([SYSTEM]);
  });

  it('Authorize then ExecuteDeferred share the DeferredExec ref; signer passkey then deferred', () => {
    const authorize = parse('mainnet-1', 'authorize').rows[0];
    const deferred = parse('mainnet-1', 'executeDeferred').rows[0];
    expect(authorize).toMatchObject({ kind: 6, auth: 1 });
    expect(deferred).toMatchObject({ kind: 7, auth: 4 });
    expect(authorize.ref).toBe(deferred.ref);
    expect(authorize.wallet).toBe(deferred.wallet);
    expect(authorize.app).not.toBeNull();
  });

  it('RevokeSession + CreateSession in one transaction gives two rows', () => {
    const { rows } = parse('mainnet-1', 'revokeThenCreateSession');
    expect(rows.map((r) => [r.ix_seq, r.kind])).toEqual([[0, 9], [1, 5]]);
    expect(rows[0].net_fee_lamports).not.toBeNull();
    expect(rows[1].net_fee_lamports).toBeNull();
    expect(rows.every((r) => r.auth === 3 || r.auth === 2 || r.auth === 1)).toBe(true);
  });

  it('program-ping bot failure is noise, not a real transaction', () => {
    const { rows } = parse('mainnet-1', 'pingBotFailure');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 254, ok: false, fail_class: 'noise', wallet: null, payer: null, tx_version: -1 });
  });

  it('CreateWallet AccountAlreadyInitialized is a duplicate and pays no fee', () => {
    const { rows } = parse('mainnet-1', 'createWalletDuplicate');
    expect(rows[0]).toMatchObject({ kind: 0, ok: false, fail_class: 'duplicate', fee_lamports: 0 });
  });

  it('a Program Metadata write in the feed has no LazorKit instruction', () => {
    const { rows } = parse('mainnet-1', 'programMetadataWrite');
    expect(rows).toEqual([expect.objectContaining({ kind: 255, ix_seq: 0, flags: 0, ref: null })]);
  });

  it("the program's DeployWithMaxDataLen is flagged as history start", () => {
    const { rows } = parse('mainnet-1', 'deploy');
    expect(rows[0]).toMatchObject({ kind: 255, ref: 'deploy', slot: 416473155 });
    expect(rows[0].flags).toBe(FLAGS.HISTORY_START | FLAGS.LOADER_OP);
  });

  it('InitializeTreasuryShard records the shard funding (post-balance)', () => {
    const { rows, tx } = parse('mainnet-1', 'initializeTreasuryShard');
    const acc = ixAccounts(tx, V1_MAINNET);
    const shardIndex = tx.transaction.message.accountKeys.indexOf(acc[3]);
    expect(rows[0]).toMatchObject({ kind: 14, ref: acc[3], amount_lamports: tx.meta?.postBalances[shardIndex] });
    expect(rows[0].amount_lamports).toBeGreaterThan(0);
  });

  it('v0 with an address lookup table resolves loaded keys', () => {
    const { rows, tx } = parse('mainnet-1', 'executeV0WithLookupTable');
    expect((tx.meta?.loadedAddresses?.readonly.length ?? 0) + (tx.meta?.loadedAddresses?.writable.length ?? 0)).toBeGreaterThan(0);
    const acc = ixAccounts(tx, V1_MAINNET);
    expect(rows[0]).toMatchObject({ kind: 4, wallet: acc[1], ref: acc[3] });
    expect(rows[0].cpi?.length).toBeGreaterThan(0);
    expect(rows[0].cpi?.every((program) => program.length >= 32)).toBe(true);
  });

  it('Android apps are attributed by the apk key hash prefix', () => {
    expect(parse('mainnet-1', 'executeAndroidOrigin').rows[0].app).toBe('android:FeZAqinn');
  });

  it('an embedded portal is attributed to its topOrigin', () => {
    expect(parse('mainnet-1', 'authorizeTopOrigin').rows[0].app).toBe('localhost:5173');
  });

  it('ReclaimDeferred has no wallet and returns the DeferredExec rent', () => {
    const { rows } = parse('mainnet-1', 'reclaimDeferred');
    expect(rows[0]).toMatchObject({ kind: 8, wallet: null });
    expect(rows[0].amount_lamports).toBeGreaterThan(0);
  });
});

describe('parser: v1 devnet', () => {
  it('RegisterPayer + CreateWallet gives two rows', () => {
    const { rows } = parse('devnet-3', 'registerPayerThenCreateWallet');
    expect(rows.map((r) => r.kind)).toEqual([12, 0]);
    expect(rows[0].wallet).toBeNull();
  });

  it('8 x ReclaimDeferred in one transaction', () => {
    const { rows } = parse('devnet-3', 'eightReclaimDeferred');
    expect(rows).toHaveLength(8);
    expect(rows.every((r) => r.kind === 8 && r.wallet === null && (r.amount_lamports ?? 0) > 0)).toBe(true);
    expect(rows.map((r) => r.ix_seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('Execute failing with Custom 1 from an inner System transfer is a cpi failure', () => {
    expect(parse('devnet-3', 'executeCustom1').rows[0]).toMatchObject({ kind: 4, ok: false, fail_class: 'cpi', err_code: 1 });
  });

  it('a LazorKit InvalidAccountData failure is class lazorkit', () => {
    expect(parse('devnet-3', 'executeDeferredInvalidAccountData').rows[0]).toMatchObject({ kind: 7, ok: false, fail_class: 'lazorkit' });
  });

  it('an rpId with a scheme prefix (older devnet clients) is normalised', () => {
    expect(parse('devnet-3', 'createWalletSchemeRpId').rows[0]).toMatchObject({ kind: 0, auth: 1, app: 'portal.lazor.sh' });
  });

  it('devnet v1 deploy is the history start', () => {
    expect(parse('devnet-3', 'deploy').rows[0].flags & FLAGS.HISTORY_START).toBeTruthy();
  });
});

describe('parser: v2 devnet', () => {
  it('transaction version 1 (SIMD-0385) Execute parses', () => {
    const { rows } = parse('devnet-4', 'txV1ExecuteOk');
    expect(rows[0]).toMatchObject({ kind: 4, ok: true, tx_version: 1, auth: 1 });
  });

  it('transaction version 1 ExecuteDeferred with 58 keys parses', () => {
    const { rows, tx } = parse('devnet-4', 'txV1ExecuteDeferred58Keys');
    expect(tx.transaction.message.accountKeys.length).toBe(58);
    expect(rows[0]).toMatchObject({ kind: 7, tx_version: 1, auth: 4 });
  });

  it('MaxLoadedAccountsDataSizeExceeded (no instruction index) is class limits', () => {
    expect(parse('devnet-4', 'txV1MaxLoadedAccounts').rows[0]).toMatchObject({ ok: false, fail_class: 'limits', tx_version: 1 });
  });

  it('ProgramFailedToComplete at the LazorKit instruction is class limits', () => {
    expect(parse('devnet-4', 'txV1ProgramFailedToComplete').rows[0]).toMatchObject({ kind: 4, ok: false, fail_class: 'limits' });
  });

  it('3006 SignatureReused is a duplicate', () => {
    expect(parse('devnet-4', 'signatureReused3006').rows[0]).toMatchObject({ kind: 4, fail_class: 'duplicate', err_code: 3006 });
  });

  it('v2 CreateWallet carries the mandatory suffix and pays 0 while fees are unconfigured', () => {
    const { rows } = parse('devnet-4', 'createWalletFeesUnconfigured');
    expect(rows[0]).toMatchObject({ kind: 0, ok: true, fee_lamports: 0, auth: 1, app: 'portal.lazor.sh' });
    expect(rows[0].flags & FLAGS.FEE_SUFFIX).toBeTruthy();
  });

  it('Authorize embedded with crossOrigin / topOrigin is attributed to localhost:3000', () => {
    expect(parse('devnet-4', 'authorizeTopOriginLocalhost3000').rows[0]).toMatchObject({ kind: 6, app: 'localhost:3000' });
  });

  it('v2 ReclaimDeferred', () => {
    const { rows } = parse('devnet-4', 'reclaimDeferred');
    expect(rows[0]).toMatchObject({ kind: 8, wallet: null });
    expect(rows[0].amount_lamports).toBeGreaterThan(0);
  });

  it('v2 devnet deploy is the history start', () => {
    expect(parse('devnet-4', 'deploy').rows[0]).toMatchObject({ kind: 255, ref: 'deploy' });
  });

  it('nothing in the v2 devnet feed is shared with v1 devnet', () => {
    for (const name of Object.keys(FIXTURE_SIGNATURES['devnet-4']) as Array<keyof (typeof FIXTURE_SIGNATURES)['devnet-4']>) {
      expect(parse('devnet-4', name).rows.every((r) => r.shared === false)).toBe(true);
    }
  });
});

describe('parser: synthetic (never seen on chain)', () => {
  it('WithdrawTreasury (13) records the amount swept from the shard', () => {
    const { rows } = parseTransaction(withdrawTreasury(), parseContextFor(1));
    expect(rows[0]).toMatchObject({ kind: 13, wallet: null, amount_lamports: 1_215_000 });
  });

  it('MigrateWallet (17): v1 wallet -> v2 vault, SOL from the inner transfer, two token accounts, Ed25519 owner', () => {
    const fixture = migrateWallet();
    const { rows } = parseTransaction(fixture.tx, parseContextFor(1));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 17, wallet: fixture.v1Wallet, ref: fixture.destination,
      amount_lamports: fixture.vaultLamports, tokens: 2, auth: 3 });
  });

  it('an inner (CPI) CreateWallet is found, with its fee child at stack height 3', () => {
    const fixture = innerCreateWallet();
    const { rows } = parseTransaction(fixture.tx, parseContextFor(2));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 0, inner_ix: true, top_ix: 0, fee_lamports: 5000, auth: 3 });
    expect(rows[0].flags & FLAGS.FEE_SUFFIX).toBeTruthy();
  });

  it('a transaction with real instructions of both programs of a cluster is shared', () => {
    const fixture = migrateWallet();
    const tx = structuredClone(fixture.tx);
    const keys = tx.transaction.message.accountKeys;
    keys.push('LazorFroiVuAjcwwQ2me83vTr5nc5NRxSaTg3pmEXC8');
    tx.meta?.preBalances.push(1);
    tx.meta?.postBalances.push(1);
    tx.transaction.message.instructions.push({ programIdIndex: keys.length - 1, accounts: [0, 1, 2], data: '1' });
    const v1 = parseTransaction(tx, parseContextFor(1)).rows;
    const v2 = parseTransaction(tx, parseContextFor(2)).rows;
    expect(v1.every((r) => r.shared)).toBe(true);
    expect(v2.every((r) => r.shared)).toBe(true);
    expect(v2[0].kind).toBe(0);
  });

  it('a malformed transaction becomes one PARSE_ERROR noise row instead of throwing', () => {
    const tx = structuredClone(withdrawTreasury());
    tx.transaction.message.instructions[0].programIdIndex = 99;
    const result = parseTransaction(tx, parseContextFor(1));
    expect(result.rows).toEqual([expect.objectContaining({ kind: 254, flags: FLAGS.PARSE_ERROR, ix_seq: 0 })]);
    expect(result.warnings).toHaveLength(1);
  });

  it('a missing blockTime uses the queued block time', () => {
    const tx = structuredClone(withdrawTreasury());
    tx.blockTime = null;
    const { rows } = parseTransaction(tx, parseContextFor(1), undefined, '2026-09-01T00:00:00.000Z');
    expect(rows[0].block_time).toBe('2026-09-01T00:00:00.000Z');
  });
});

describe('parser: every real fixture', () => {
  it('parses without warnings and every signature has exactly one ix_seq 0 row', () => {
    for (const dir of Object.keys(FIXTURE_SIGNATURES) as Dir[]) {
      for (const signature of Object.values(FIXTURE_SIGNATURES[dir])) {
        const tx = JSON.parse(readFileSync(fixturePath(dir, signature), 'utf8')) as RawTransaction;
        const { rows, warnings } = parseTransaction(tx, parseContextFor(PROGRAM_KEY[dir]));
        expect(warnings).toEqual([]);
        expect(rows.filter((r) => r.ix_seq === 0)).toHaveLength(1);
        expect(rows.every((r) => r.signature === signature)).toBe(true);
        expect(new Set(rows.map((r) => r.ok)).size).toBe(1);
      }
    }
  });
});
