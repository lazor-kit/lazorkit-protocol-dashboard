// PDA derivation through the published SDKs (explicit program id), v1 = @lazorkit/sdk-legacy@0.3.2 (bare seeds),
// v2 = @lazorkit/sdk-legacy@1.3.1 (lk2: seeds).

import { PublicKey } from '@solana/web3.js';
import * as sdkV1 from '@lazorkit/sdk-legacy-v1';
import * as sdkV2 from '@lazorkit/sdk-legacy-v2';
import bs58 from 'bs58';
import type { Cluster, ProtocolVersion } from '../../src/types/protocol.js';
import { PROGRAMS } from '../../src/types/protocol.js';
import type { ParseContext } from '../types.js';
import { PARSER_VERSION } from './constants.js';

type Sdk = typeof sdkV2;

function sdkFor(version: ProtocolVersion): Pick<Sdk, 'findVaultPda' | 'findAuthorityPda' | 'findSessionPda' |
  'findProtocolConfigPda' | 'findTreasuryShardPda' | 'findFeeRecordPda'> {
  return version === 1 ? sdkV1 : sdkV2;
}

export function treasuryShardPda(version: ProtocolVersion, programId: string, shardId: number): string {
  return sdkFor(version).findTreasuryShardPda(shardId, new PublicKey(programId))[0].toBase58();
}

export function protocolConfigPda(version: ProtocolVersion, programId: string): string {
  return sdkFor(version).findProtocolConfigPda(new PublicKey(programId))[0].toBase58();
}

export function vaultPda(version: ProtocolVersion, programId: string, wallet: string): string {
  return sdkFor(version).findVaultPda(new PublicKey(wallet), new PublicKey(programId))[0].toBase58();
}

export function feeRecordPda(version: ProtocolVersion, programId: string, payer: string): string {
  return sdkFor(version).findFeeRecordPda(new PublicKey(payer), new PublicKey(programId))[0].toBase58();
}

function keyBytes(address: string): Uint8Array | null {
  try {
    const bytes = bs58.decode(address);
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

export function sessionPda(version: ProtocolVersion, programId: string, wallet: string, sessionKey: string): string | null {
  const seed = keyBytes(sessionKey);
  const walletKey = keyBytes(wallet);
  if (!seed || !walletKey) return null;
  return sdkFor(version).findSessionPda(new PublicKey(walletKey), seed, new PublicKey(programId))[0].toBase58();
}

export function authorityPda(version: ProtocolVersion, programId: string, wallet: string, idSeed: string): string | null {
  const seed = keyBytes(idSeed);
  const walletKey = keyBytes(wallet);
  if (!seed || !walletKey) return null;
  return sdkFor(version).findAuthorityPda(new PublicKey(walletKey), seed, new PublicKey(programId))[0].toBase58();
}

const shardSetCache = new Map<string, ReadonlySet<string>>();

/** Canonical TreasuryShard PDAs for shard ids 0..255 (derived once per program). */
export function canonicalShardSet(version: ProtocolVersion, programId: string): ReadonlySet<string> {
  const cacheKey = `${version}:${programId}`;
  const cached = shardSetCache.get(cacheKey);
  if (cached) return cached;
  const set = new Set<string>();
  for (let id = 0; id < 256; id += 1) set.add(treasuryShardPda(version, programId, id));
  shardSetCache.set(cacheKey, set);
  return set;
}

const contextCache = new Map<string, ParseContext>();

export function parseContextFor(programKey: number, parserVersion = PARSER_VERSION): ParseContext {
  const cacheKey = `${programKey}:${parserVersion}`;
  const cached = contextCache.get(cacheKey);
  if (cached) return cached;
  const program = PROGRAMS.find((p) => p.programKey === programKey);
  if (!program) throw new Error(`unknown program key ${programKey}`);
  const other = PROGRAMS.find((p) => p.cluster === program.cluster && p.programKey !== programKey) ?? null;
  const memoSession = new Map<string, string | null>();
  const memoAuthority = new Map<string, string | null>();
  const ctx: ParseContext = {
    programKey: program.programKey,
    programId: program.programId,
    version: program.version,
    cluster: program.cluster as Cluster,
    otherProgramId: other?.programId ?? null,
    shardSet: canonicalShardSet(program.version, program.programId),
    configPda: protocolConfigPda(program.version, program.programId),
    sessionPda(wallet, sessionKey) {
      const key = `${wallet}:${sessionKey}`;
      if (!memoSession.has(key)) memoSession.set(key, sessionPda(program.version, program.programId, wallet, sessionKey));
      return memoSession.get(key) ?? null;
    },
    authorityPda(wallet, idSeed) {
      const key = `${wallet}:${idSeed}`;
      if (!memoAuthority.has(key)) {
        memoAuthority.set(key, authorityPda(program.version, program.programId, wallet, idSeed));
      }
      return memoAuthority.get(key) ?? null;
    },
    parserVersion,
  };
  contextCache.set(cacheKey, ctx);
  return ctx;
}
