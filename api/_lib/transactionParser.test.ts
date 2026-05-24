import bs58 from 'bs58';
import { PublicKey, SystemProgram, type ParsedTransactionWithMeta } from '@solana/web3.js';
import {
  computePositiveLamportDelta,
  parseLazorKitTransaction,
} from './transactionParser.js';
import { programIdForCluster } from '../../src/solana/shared.js';

function txFixture(params: {
  discriminator: number;
  err?: unknown;
  blockTime?: number | null;
  includeSuffix?: boolean;
}): ParsedTransactionWithMeta {
  const programId = programIdForCluster('mainnet');
  const feePayer = PublicKey.unique();
  const wallet = PublicKey.unique();
  const vault = PublicKey.unique();
  const authority = PublicKey.unique();
  const protocolConfig = PublicKey.unique();
  const feeRecord = PublicKey.unique();
  const treasuryShard = PublicKey.unique();
  const accounts = [
    feePayer,
    wallet,
    vault,
    authority,
    ...(params.includeSuffix === false
      ? []
      : [protocolConfig, feeRecord, treasuryShard, SystemProgram.programId]),
  ];
  const accountKeys = [feePayer, wallet, vault, authority, treasuryShard].map(
    (pubkey) => ({
      pubkey,
      signer: pubkey.equals(feePayer),
      writable: true,
      source: 'transaction' as const,
    }),
  );

  return {
    slot: 100,
    blockTime:
      params.blockTime === undefined ? 1_700_000_000 : params.blockTime,
    transaction: {
      signatures: ['sig'],
      message: {
        accountKeys,
        recentBlockhash: 'hash',
        instructions: [
          {
            programId,
            accounts,
            data: bs58.encode(Uint8Array.from([params.discriminator, 1, 2])),
          },
        ],
      },
    },
    meta: {
      err: params.err ?? null,
      fee: 5000,
      preBalances: [10_000, 0, 0, 0, 1_000],
      postBalances: [8_000, 0, 0, 0, 2_500],
      innerInstructions: [],
      logMessages: [],
      postTokenBalances: [],
      preTokenBalances: [],
      rewards: [],
      loadedAddresses: { writable: [], readonly: [] },
      computeUnitsConsumed: 0,
    },
  } as ParsedTransactionWithMeta;
}

describe('transaction parser', () => {
  it.each([
    [0, 'CreateWallet'],
    [4, 'Execute'],
    [7, 'ExecuteDeferred'],
  ] as const)('parses discriminator %s', (discriminator, method) => {
    const parsed = parseLazorKitTransaction(
      'mainnet',
      'signature',
      txFixture({ discriminator }),
    );

    expect(parsed.row?.method).toBe(method);
    expect(parsed.row?.fee_payer).toBeDefined();
    expect(parsed.row?.wallet_pda).toBeDefined();
    expect(parsed.row?.protocol_fee_lamports).toBe('1500');
    expect(parsed.row?.status).toBe('success');
  });

  it('stores failed transaction fees as zero', () => {
    const parsed = parseLazorKitTransaction(
      'mainnet',
      'signature',
      txFixture({ discriminator: 4, err: { InstructionError: [0, 'Custom'] } }),
    );
    expect(parsed.row?.status).toBe('failed');
    expect(parsed.row?.protocol_fee_lamports).toBe('0');
  });

  it('keeps warnings for malformed fee suffix and missing block time', () => {
    const parsed = parseLazorKitTransaction(
      'mainnet',
      'signature',
      txFixture({ discriminator: 0, includeSuffix: false, blockTime: null }),
    );
    expect(parsed.row?.parse_warnings).toContain('Protocol fee suffix missing');
    expect(parsed.row?.parse_warnings).toContain('Missing blockTime');
  });

  it('computes only positive lamport deltas', () => {
    expect(computePositiveLamportDelta('b', ['a', 'b'], [10, 4], [8, 9])).toBe(
      5n,
    );
    expect(computePositiveLamportDelta('b', ['a', 'b'], [10, 9], [8, 4])).toBe(
      0n,
    );
    expect(computePositiveLamportDelta('c', ['a', 'b'], [10, 9], [8, 4])).toBe(
      0n,
    );
  });
});
