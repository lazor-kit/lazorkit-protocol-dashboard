// SYNTHETIC transactions for cases that have never happened on chain (labelled as such; built from the program
// source layouts, not observed). Each builder names the u3-data-model section it follows.
//   withdrawTreasury    u3 §4.2 #13 (admin s, config, shard w, treasury w, rent), §5.3 (WithdrawTreasury leaves
//                       the rent minimum)
//   migrateWallet       u3 §4.2 #17 / §6.5 (payer, v1_wallet, v1_authority, v1_vault, destination, refund, system,
//                       sysvar, auth_signer, then 4 accounts per token; inner TransferChecked + CloseAccount per
//                       token, then System transfer vault -> destination), at the v1 id running the sunset build
//   innerCreateWallet   u3 §7.2 (CreateWallet may be CPI'd by an integrator) + §5.1 (fee transfer is the first
//                       child of a fee-bearing instruction)
//   firstFeeExecute     lazorkit-protocol program/src/entrypoint.rs try_collect_fee: with fees on, a first-time
//                       payer's FeeRecord is created inline (utils.rs initialize_pda_account: Transfer payer ->
//                       record for the rent, Allocate, Assign) BEFORE the fee Transfer payer -> treasury shard

import bs58 from 'bs58';
import { PROGRAMS } from '../../../src/types/protocol.js';
import { authorityPda, feeRecordPda, protocolConfigPda, treasuryShardPda } from '../../chain/pdas.js';
import type { RawTransaction } from '../../types.js';

const SYSTEM = '11111111111111111111111111111111';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const RENT = 'SysvarRent111111111111111111111111111111111';
const IX_SYSVAR = 'Sysvar1nstructions1111111111111111111111111';
const V1_MAINNET = PROGRAMS[0].programId;
const V2_MAINNET = PROGRAMS[1].programId;

/** Deterministic fake addresses (32 bytes, base58). */
export function fakeKey(label: string): string {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < label.length; i += 1) bytes[i % 32] = (bytes[i % 32] * 31 + label.charCodeAt(i) + i) & 0xff;
  bytes[31] = 0x42;
  return bs58.encode(bytes);
}

function u64le(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true);
  return bytes;
}

function systemTransfer(lamports: number): string {
  return bs58.encode(new Uint8Array([2, 0, 0, 0, ...u64le(lamports)]));
}

interface Builder {
  keys: string[];
  index(key: string): number;
}

function builder(signers: string[], rest: string[]): Builder {
  const keys = [...signers];
  for (const key of rest) if (!keys.includes(key)) keys.push(key);
  return { keys, index: (key) => keys.indexOf(key) };
}

function tx(
  signature: string,
  b: Builder,
  numSigners: number,
  instructions: RawTransaction['transaction']['message']['instructions'],
  inner: NonNullable<RawTransaction['meta']>['innerInstructions'],
  balances: Record<string, [number, number]>,
  err: unknown = null,
): RawTransaction {
  return {
    slot: 470_000_000,
    blockTime: 1_790_000_000,
    version: 0,
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: b.keys,
        header: { numRequiredSignatures: numSigners, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 },
        instructions,
      },
    },
    meta: {
      err,
      fee: 5000 * numSigners,
      preBalances: b.keys.map((key) => balances[key]?.[0] ?? 1),
      postBalances: b.keys.map((key) => balances[key]?.[1] ?? 1),
      innerInstructions: inner,
      loadedAddresses: { writable: [], readonly: [] },
      logMessages: [],
    },
  };
}

/** WithdrawTreasury (kind 13) at v1 mainnet: shard 3 sweeps 1,215,000 lamports to the treasury. */
export function withdrawTreasury(): RawTransaction {
  const admin = fakeKey('admin');
  const treasury = fakeKey('treasury');
  const config = protocolConfigPda(1, V1_MAINNET);
  const shard = treasuryShardPda(1, V1_MAINNET, 3);
  const b = builder([admin], [config, shard, treasury, RENT, V1_MAINNET]);
  return tx(
    'SyntheticWithdrawTreasury1111111111111111111111111111111111111111111111111111111111',
    b,
    1,
    [{ programIdIndex: b.index(V1_MAINNET), accounts: [admin, config, shard, treasury, RENT].map(b.index), data: bs58.encode(new Uint8Array([13])) }],
    [],
    { [shard]: [2_161_560, 946_560], [treasury]: [0, 1_215_000] },
  );
}

export interface MigrateFixture {
  tx: RawTransaction;
  v1Wallet: string;
  destination: string;
  vaultLamports: number;
}

/** MigrateWallet (kind 17) at the v1 mainnet id (sunset build): Ed25519 owner, two token accounts. */
export function migrateWallet(): MigrateFixture {
  const payer = fakeKey('relayer');
  const owner = fakeKey('v1-owner-ed25519');
  const v1Wallet = fakeKey('v1-wallet');
  const v1Authority = authorityPda(1, V1_MAINNET, v1Wallet, owner) as string;
  const v1Vault = fakeKey('v1-vault');
  const destination = fakeKey('v2-vault');
  const refund = payer;
  const tokens = [0, 1].map((i) => ({
    source: fakeKey(`src-ata-${i}`),
    dest: fakeKey(`dst-ata-${i}`),
    mint: fakeKey(`mint-${i}`),
  }));
  const ixAccounts = [payer, v1Wallet, v1Authority, v1Vault, destination, refund, SYSTEM, IX_SYSVAR, owner,
    ...tokens.flatMap((t) => [t.source, t.dest, t.mint, TOKEN])];
  const b = builder([payer, owner], [...ixAccounts, V1_MAINNET]);
  const vaultLamports = 3_456_789;
  const inner = [
    ...tokens.flatMap((t) => [
      { programIdIndex: b.index(TOKEN), accounts: [t.source, t.mint, t.dest, v1Vault].map(b.index), data: bs58.encode(new Uint8Array([12, ...u64le(1000), 6])), stackHeight: 2 },
      { programIdIndex: b.index(TOKEN), accounts: [t.source, refund, v1Vault].map(b.index), data: bs58.encode(new Uint8Array([9])), stackHeight: 2 },
    ]),
    { programIdIndex: b.index(SYSTEM), accounts: [v1Vault, destination].map(b.index), data: systemTransfer(vaultLamports), stackHeight: 2 },
  ];
  return {
    tx: tx(
      'SyntheticMigrateWallet11111111111111111111111111111111111111111111111111111111111111',
      b,
      2,
      [{ programIdIndex: b.index(V1_MAINNET), accounts: ixAccounts.map(b.index), data: bs58.encode(new Uint8Array([17, 2])) }],
      [{ index: 0, instructions: inner }],
      { [v1Vault]: [vaultLamports, 0], [destination]: [0, vaultLamports] },
    ),
    v1Wallet,
    destination,
    vaultLamports,
  };
}

/**
 * An integrator program CPIs LazorKit v2 mainnet CreateWallet (Ed25519 owner) with the fee suffix; the fee
 * transfer is the first child of the inner LazorKit instruction (stack height 3).
 */
export function innerCreateWallet(): { tx: RawTransaction; shard: string } {
  const payer = fakeKey('integrator-payer');
  const integrator = fakeKey('integrator-program');
  const wallet = fakeKey('inner-wallet');
  const vault = fakeKey('inner-vault');
  const authority = fakeKey('inner-authority');
  const config = protocolConfigPda(2, V2_MAINNET);
  const feeRecord = fakeKey('inner-fee-record');
  const shard = treasuryShardPda(2, V2_MAINNET, 7);
  const lkAccounts = [payer, wallet, vault, authority, SYSTEM, RENT, config, feeRecord, shard, SYSTEM];
  const b = builder([payer], [...lkAccounts, integrator, V2_MAINNET]);
  const data = new Uint8Array(73);
  data[0] = 0; // CreateWallet
  data[33] = 0; // Ed25519 owner
  const inner = [
    { programIdIndex: b.index(V2_MAINNET), accounts: lkAccounts.map(b.index), data: bs58.encode(data), stackHeight: 2 },
    { programIdIndex: b.index(SYSTEM), accounts: [payer, shard].map(b.index), data: systemTransfer(5000), stackHeight: 3 },
    { programIdIndex: b.index(SYSTEM), accounts: [payer, wallet].map(b.index), data: systemTransfer(946_560), stackHeight: 3 },
    { programIdIndex: b.index(SYSTEM), accounts: [payer, authority].map(b.index), data: systemTransfer(1_447_680), stackHeight: 3 },
  ];
  return {
    tx: tx(
      'SyntheticInnerCreateWallet111111111111111111111111111111111111111111111111111111111',
      b,
      1,
      [{ programIdIndex: b.index(integrator), accounts: [payer, wallet].map(b.index), data: bs58.encode(new Uint8Array([1, 2, 3])) }],
      [{ index: 0, instructions: inner }],
      { [shard]: [946_560, 951_560] },
    ),
    shard,
  };
}

function systemAllocate(space: number): string {
  return bs58.encode(new Uint8Array([8, 0, 0, 0, ...u64le(space)]));
}

function systemAssign(owner: string): string {
  return bs58.encode(new Uint8Array([1, 0, 0, 0, ...bs58.decode(owner)]));
}

export interface FirstFeeFixture {
  tx: RawTransaction;
  payer: string;
  feeRecord: string;
  shard: string;
  fee: number;
}

/**
 * Execute (kind 4) at v2 mainnet with fees on. `firstTime`: the payer has no FeeRecord yet, so the program creates
 * it (Transfer payer -> record 1,113,600 rent, Allocate, Assign) before the 5,000 lamport fee transfer to shard 5;
 * then the vault calls SPL Token. Otherwise only the fee transfer precedes the vault's call.
 */
export function firstFeeExecute(firstTime: boolean): FirstFeeFixture {
  const payer = fakeKey(`fee-payer-${firstTime ? 'new' : 'known'}`);
  const signer = fakeKey('fee-ed25519-signer');
  const wallet = fakeKey('fee-wallet');
  const authority = authorityPda(2, V2_MAINNET, wallet, signer) as string;
  const vault = fakeKey('fee-vault');
  const source = fakeKey('fee-src-ata');
  const dest = fakeKey('fee-dst-ata');
  const config = protocolConfigPda(2, V2_MAINNET);
  const feeRecord = feeRecordPda(2, V2_MAINNET, payer);
  const shard = treasuryShardPda(2, V2_MAINNET, 5);
  const fee = 5000;
  const lkAccounts = [payer, wallet, authority, vault, IX_SYSVAR, TOKEN, source, dest, config, feeRecord, shard, SYSTEM];
  const b = builder([payer, signer], [...lkAccounts, V2_MAINNET]);
  const data = new Uint8Array(16);
  data[0] = 4; // Execute
  const creation = firstTime
    ? [
        { programIdIndex: b.index(SYSTEM), accounts: [payer, feeRecord].map(b.index), data: systemTransfer(1_113_600), stackHeight: 2 },
        { programIdIndex: b.index(SYSTEM), accounts: [feeRecord].map(b.index), data: systemAllocate(32), stackHeight: 2 },
        { programIdIndex: b.index(SYSTEM), accounts: [feeRecord].map(b.index), data: systemAssign(V2_MAINNET), stackHeight: 2 },
      ]
    : [];
  const inner = [
    ...creation,
    { programIdIndex: b.index(SYSTEM), accounts: [payer, shard].map(b.index), data: systemTransfer(fee), stackHeight: 2 },
    { programIdIndex: b.index(TOKEN), accounts: [source, dest, vault].map(b.index), data: bs58.encode(new Uint8Array([3, ...u64le(10)])), stackHeight: 2 },
  ];
  return {
    tx: tx(
      `SyntheticFirstFeeExecute${firstTime ? 'New' : 'Known'}11111111111111111111111111111111111111111111111111111`,
      b,
      2,
      [{ programIdIndex: b.index(V2_MAINNET), accounts: lkAccounts.map(b.index), data: bs58.encode(data) }],
      [{ index: 0, instructions: inner }],
      { [shard]: [946_560, 946_560 + fee], [feeRecord]: [firstTime ? 0 : 1_113_600, 1_113_600] },
    ),
    payer,
    feeRecord,
    shard,
    fee,
  };
}
