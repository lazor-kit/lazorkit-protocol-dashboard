// State decoders on full getProgramAccounts dumps (2026-10-01, read-only). Expected values: u4-probe §2.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { decodeProgramState, type ProgramAccount } from './decoders.js';

const here = dirname(fileURLToPath(import.meta.url));

function load(name: string): { slot: number; accounts: ProgramAccount[] } {
  const raw = JSON.parse(gunzipSync(readFileSync(join(here, '..', '__fixtures__', 'gpa', `${name}.json.gz`))).toString('utf8')) as {
    slot: number;
    list: Array<{ pubkey: string; lamports: number; data: string }>;
  };
  return {
    slot: raw.slot,
    accounts: raw.list.map((a) => ({ pubkey: a.pubkey, lamports: a.lamports, data: new Uint8Array(Buffer.from(a.data, 'base64')) })),
  };
}

const RENT_8 = 690_880n; // getMinimumBalanceForRentExemption(8) in October 2026

describe('state decoders', () => {
  it('v1 mainnet', () => {
    const { slot, accounts } = load('gpa-mainnet-Lazorj');
    const { totals, detail, wallets } = decodeProgramState(accounts, { version: 1, slot, rentMinimum8: RENT_8 });
    expect(totals.accounts).toBe(675);
    expect(totals.wallets).toBe(182);
    expect(wallets).toHaveLength(182);
    expect(totals.multiOwnerWallets).toBeNull();
    expect(totals.authorities).toEqual({ total: 209, owner: 189, admin: 20, delegate: 0, passkey: 174, ed25519: 35, legacyLayout: 0 });
    expect(totals.ownerTypes.passkeyWallets + totals.ownerTypes.ed25519Wallets + totals.ownerTypes.mixedWallets).toBe(182);
    expect(totals.passkeyOpsLifetime).toBe(634);
    expect(totals.sessions).toEqual({ total: 169, live: 3, expired: 166, withPolicy: 161 });
    expect(totals.deferred).toEqual({ total: 96, pending: 0, expired: 96, expiredLamports: '197405440' });
    expect(totals.config).toMatchObject({ address: '8mnK3NDPKJEgwDnq2h73sEbdPAvtMrGXaTZimsG5wzeA', enabled: true, numShards: 16,
      creationFee: '5000', executionFee: '5000', pendingAdmin: null });
    expect(totals.feeRecords).toMatchObject({ count: 2, totalFeesPaid: '1630000', txCount: 248, walletCount: 78 });
    expect(Number(totals.feeRecords.top[0].totalFeesPaid)).toBeGreaterThanOrEqual(Number(totals.feeRecords.top[1].totalFeesPaid));
    expect(totals.feeRecords.top[0].registeredSlot).toBeGreaterThan(400_000_000); // a slot, not a unix time
    expect(totals.treasury).toEqual({ shards: 16, lamports: '17359960', withdrawableNow: '6305880' });
    expect(detail.shards.map((s) => s.id)).toEqual(Array.from({ length: 16 }, (_, i) => i));
    expect(detail.feeRecords).toHaveLength(2);
    expect(totals.unknownAccounts).toBe(0);
  });

  it('v1 devnet tolerates the legacy inline-rpId authorities', () => {
    const { slot, accounts } = load('gpa-devnet-4h3XoN');
    const { totals } = decodeProgramState(accounts, { version: 1, slot, rentMinimum8: RENT_8 });
    expect(totals.wallets).toBe(110);
    expect(totals.authorities.total).toBe(133);
    expect(totals.authorities.legacyLayout).toBe(19);
    expect(totals.authorities.delegate).toBe(4);
    expect(totals.sessions.total).toBe(36);
    expect(totals.config).toMatchObject({ enabled: true, creationFee: '5000', executionFee: '2000' });
    expect(totals.feeRecords.count).toBe(5);
    expect(totals.treasury.shards).toBe(16);
    expect(totals.unknownAccounts).toBe(0);
  });

  it('v2 devnet: owner_count, no fee layer yet', () => {
    const { slot, accounts } = load('gpa-devnet-57bTNW');
    const { totals } = decodeProgramState(accounts, { version: 2, slot, rentMinimum8: RENT_8, vaults: { funded: 18, lamports: 5_087_811_919n } });
    expect(totals.wallets).toBe(127);
    expect(totals.multiOwnerWallets).toBe(0);
    expect(totals.authorities).toMatchObject({ total: 133, owner: 127, admin: 6, passkey: 125, ed25519: 8, legacyLayout: 0 });
    expect(totals.sessions).toMatchObject({ total: 9, live: 4, expired: 5, withPolicy: 1 });
    expect(totals.deferred.total).toBe(0);
    expect(totals.config).toBeNull();
    expect(totals.feeRecords.count).toBe(0);
    expect(totals.treasury).toEqual({ shards: 0, lamports: '0', withdrawableNow: '0' });
    expect(totals.vaults).toEqual({ funded: 18, lamports: '5087811919' });
  });

  it('never mixes the v1 and v2 namespaces: v1 accounts decoded as v2 are unknown', () => {
    const { slot, accounts } = load('gpa-mainnet-Lazorj');
    const { totals } = decodeProgramState(accounts, { version: 2, slot, rentMinimum8: RENT_8 });
    expect(totals.wallets).toBe(0);
    expect(totals.unknownAccounts).toBe(675);
  });

  it('a v1 Wallet and a v1 TreasuryShard (both 8 B) are told apart by byte 0', () => {
    const wallet = { pubkey: 'W', lamports: 1, data: new Uint8Array([1, 255, 1, 0, 0, 0, 0, 0]) };
    const shard = { pubkey: 'S', lamports: 2_000_000, data: new Uint8Array([7, 255, 3, 0, 0, 0, 0, 0]) };
    const { totals } = decodeProgramState([wallet, shard], { version: 1, slot: 1, rentMinimum8: RENT_8 });
    expect(totals.wallets).toBe(1);
    expect(totals.treasury).toEqual({ shards: 1, lamports: '2000000', withdrawableNow: String(2_000_000n - RENT_8) });
  });
});
