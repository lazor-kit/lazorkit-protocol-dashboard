// Account decoders for the state snapshot (spec §7). Layouts from program source v1@ff125de / v2@5fb8d46
// (u3-data-model §3). Always filter on byte 0: a v1 Wallet and a v1 TreasuryShard are both 8 bytes.
// DeferredExec and ProtocolConfig order their first bytes disc, version, bump (not disc, bump, version).

import bs58 from 'bs58';
import type { FeeRecordView, StateDetail, StateTotals } from '../../src/types/dashboard.js';
import { accountDiscs, PROTOCOL_CONFIG_SIZE } from '../chain/constants.js';

export interface ProgramAccount {
  pubkey: string;
  lamports: number;
  data: Uint8Array;
}

function view(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

function u64(data: Uint8Array, offset: number): bigint {
  return view(data).getBigUint64(offset, true);
}

function u32(data: Uint8Array, offset: number): number {
  return view(data).getUint32(offset, true);
}

function key(data: Uint8Array, offset: number): string {
  return bs58.encode(data.subarray(offset, offset + 32));
}

function isZero(data: Uint8Array, offset: number, length: number): boolean {
  for (let i = offset; i < offset + length; i += 1) if (data[i] !== 0) return false;
  return true;
}

export interface DecodedState {
  totals: StateTotals;
  detail: StateDetail;
  wallets: string[];
}

export interface DecodeOptions {
  version: 1 | 2;
  slot: number;
  rentMinimum8: bigint;
  configPda?: string;
  vaults?: { funded: number; lamports: bigint };
}

export function decodeProgramState(accounts: readonly ProgramAccount[], options: DecodeOptions): DecodedState {
  const disc = accountDiscs(options.version);
  const slot = BigInt(options.slot);
  const wallets: string[] = [];
  let multiOwnerWallets = 0;
  const authorities = { total: 0, owner: 0, admin: 0, delegate: 0, passkey: 0, ed25519: 0, legacyLayout: 0 };
  const ownerTypesByWallet = new Map<string, Set<number>>();
  let passkeyOpsLifetime = 0;
  const sessions = { total: 0, live: 0, expired: 0, withPolicy: 0 };
  const deferred = { total: 0, pending: 0, expired: 0, expiredLamports: 0n };
  const configs: Array<{ account: ProgramAccount; config: NonNullable<StateTotals['config']> }> = [];
  const feeRecords: FeeRecordView[] = [];
  const shards: Array<{ id: number; address: string; lamports: bigint }> = [];
  let unknownAccounts = 0;

  for (const account of accounts) {
    const data = account.data;
    const tag = data.length > 0 ? data[0] : -1;
    if (tag === disc.wallet && data.length >= 8) {
      wallets.push(account.pubkey);
      if (options.version === 2 && u32(data, 4) > 1) multiOwnerWallets += 1;
    } else if (tag === disc.authority && data.length >= 48) {
      const type = data[1];
      const role = data[2];
      authorities.total += 1;
      if (role === 0) authorities.owner += 1;
      else if (role === 1) authorities.admin += 1;
      else if (role === 2) authorities.delegate += 1;
      if (type === 1) {
        authorities.passkey += 1;
        passkeyOpsLifetime += u32(data, 8);
        // a passkey authority is 145 B (+ policy for a v2 Delegate); devnet v1 also has 123-137 B legacy
        // layouts with an inline rpId instead of sha256(rpId)
        if (data.length < 145 || (options.version === 1 && data.length !== 145)) authorities.legacyLayout += 1;
      } else if (type === 0) {
        authorities.ed25519 += 1;
      }
      if (role === 0) {
        const wallet = key(data, 16);
        const types = ownerTypesByWallet.get(wallet) ?? new Set<number>();
        types.add(type);
        ownerTypesByWallet.set(wallet, types);
      }
    } else if (tag === disc.session && data.length >= 80) {
      sessions.total += 1;
      if (u64(data, 72) >= slot) sessions.live += 1;
      else sessions.expired += 1;
      if (data.length > 80) sessions.withPolicy += 1;
    } else if (tag === disc.deferred && data.length >= 176) {
      deferred.total += 1;
      if (u64(data, 168) >= slot) deferred.pending += 1;
      else {
        deferred.expired += 1;
        deferred.expiredLamports += BigInt(account.lamports);
      }
    } else if (tag === disc.protocolConfig && data.length >= PROTOCOL_CONFIG_SIZE[options.version]) {
      configs.push({
        account,
        config: {
          address: account.pubkey,
          enabled: data[3] === 1,
          numShards: data[4],
          admin: key(data, 8),
          treasury: key(data, 40),
          creationFee: u64(data, 72).toString(),
          executionFee: u64(data, 80).toString(),
          pendingAdmin: options.version === 2 && !isZero(data, 88, 32) ? key(data, 88) : null,
        },
      });
    } else if (tag === disc.feeRecord && data.length >= 32) {
      feeRecords.push({
        address: account.pubkey,
        totalFeesPaid: u64(data, 8).toString(),
        txCount: u32(data, 16),
        walletCount: u32(data, 20),
        registeredSlot: Number(u64(data, 24)),
      });
    } else if (tag === disc.treasuryShard && data.length >= 8) {
      shards.push({ id: data[2], address: account.pubkey, lamports: BigInt(account.lamports) });
    } else {
      unknownAccounts += 1;
    }
  }

  let passkeyWallets = 0;
  let ed25519Wallets = 0;
  let mixedWallets = 0;
  for (const types of ownerTypesByWallet.values()) {
    if (types.has(0) && types.has(1)) mixedWallets += 1;
    else if (types.has(1)) passkeyWallets += 1;
    else if (types.has(0)) ed25519Wallets += 1;
  }

  const config =
    configs.find((entry) => options.configPda && entry.account.pubkey === options.configPda)?.config ??
    configs[0]?.config ??
    null;
  feeRecords.sort((a, b) => {
    const diff = BigInt(b.totalFeesPaid) - BigInt(a.totalFeesPaid);
    return diff > 0n ? 1 : diff < 0n ? -1 : a.address.localeCompare(b.address);
  });
  shards.sort((a, b) => a.id - b.id || a.address.localeCompare(b.address));
  const shardLamports = shards.reduce((sum, shard) => sum + shard.lamports, 0n);
  const withdrawable = shards.reduce(
    (sum, shard) => sum + (shard.lamports > options.rentMinimum8 ? shard.lamports - options.rentMinimum8 : 0n),
    0n,
  );

  const totals: StateTotals = {
    slot: options.slot,
    accounts: accounts.length,
    wallets: wallets.length,
    multiOwnerWallets: options.version === 2 ? multiOwnerWallets : null,
    authorities,
    ownerTypes: { passkeyWallets, ed25519Wallets, mixedWallets },
    passkeyOpsLifetime,
    sessions,
    deferred: { ...deferred, expiredLamports: deferred.expiredLamports.toString() },
    config,
    feeRecords: {
      count: feeRecords.length,
      totalFeesPaid: feeRecords.reduce((sum, record) => sum + BigInt(record.totalFeesPaid), 0n).toString(),
      txCount: feeRecords.reduce((sum, record) => sum + record.txCount, 0),
      walletCount: feeRecords.reduce((sum, record) => sum + record.walletCount, 0),
      top: feeRecords.slice(0, 10),
    },
    treasury: { shards: shards.length, lamports: shardLamports.toString(), withdrawableNow: withdrawable.toString() },
    vaults: {
      funded: options.vaults?.funded ?? 0,
      lamports: (options.vaults?.lamports ?? 0n).toString(),
    },
    rentMinimum8: options.rentMinimum8.toString(),
    unknownAccounts,
  };
  const detail: StateDetail = {
    shards: shards.map((shard) => ({ id: shard.id, address: shard.address, lamports: shard.lamports.toString() })),
    feeRecords: feeRecords.length <= 50 ? feeRecords : null,
  };
  return { totals, detail, wallets };
}
