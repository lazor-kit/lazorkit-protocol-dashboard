// Deployed-binary identification (spec §2.1 "binary hash rule", §5.2).
// sha256 of the ELF up to the end of its own tables: max(program-header table end, section-header table end,
// end of every non-NOBITS section). Never strip trailing zeros and never hash the whole allocation:
// programdata can be larger than the ELF (ExtendProgram leaves a zero tail).

import { createHash } from 'node:crypto';
import bs58 from 'bs58';

export const PROGRAMDATA_HEADER_BYTES = 45;
const SHT_NOBITS = 8;

export function elfBound(elf: Uint8Array): number {
  if (elf.length < 64 || elf[0] !== 0x7f || elf[1] !== 0x45 || elf[2] !== 0x4c || elf[3] !== 0x46) {
    throw new Error('not an ELF image');
  }
  if (elf[4] !== 2 || elf[5] !== 1) throw new Error('expected a 64-bit little-endian ELF');
  const view = new DataView(elf.buffer, elf.byteOffset, elf.byteLength);
  const phoff = Number(view.getBigUint64(0x20, true));
  const shoff = Number(view.getBigUint64(0x28, true));
  const phentsize = view.getUint16(0x36, true);
  const phnum = view.getUint16(0x38, true);
  const shentsize = view.getUint16(0x3a, true);
  const shnum = view.getUint16(0x3c, true);
  let end = Math.max(64, phoff + phnum * phentsize, shoff + shnum * shentsize);
  for (let i = 0; i < shnum; i += 1) {
    const base = shoff + i * shentsize;
    if (base + 0x28 > elf.length) throw new Error('section header table runs past the image');
    const type = view.getUint32(base + 4, true);
    if (type === SHT_NOBITS) continue;
    const offset = Number(view.getBigUint64(base + 0x18, true));
    const size = Number(view.getBigUint64(base + 0x20, true));
    end = Math.max(end, offset + size);
  }
  if (end > elf.length) throw new Error(`ELF bound ${end} exceeds the image (${elf.length} B)`);
  return end;
}

export interface BinaryIdentity {
  sha256: string;
  elfSize: number;
}

/** elf = programdata bytes after the 45-byte header (or a dumped .so). */
export function identifyElf(elf: Uint8Array): BinaryIdentity {
  const len = elfBound(elf);
  return { sha256: createHash('sha256').update(elf.subarray(0, len)).digest('hex'), elfSize: len };
}

export interface ProgramdataHeader {
  deploySlot: number;
  upgradeAuthority: string | null;
}

/** Programdata account: u32 tag (3), u64 last deploy slot, Option<Pubkey> upgrade authority. */
export function parseProgramdataHeader(data: Uint8Array): ProgramdataHeader {
  if (data.length < 13) throw new Error('programdata header too short');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tag = view.getUint32(0, true);
  if (tag !== 3) throw new Error(`unexpected programdata tag ${tag}`);
  const deploySlot = Number(view.getBigUint64(4, true));
  const upgradeAuthority = data[12] === 1 && data.length >= 45 ? bs58.encode(data.subarray(13, 45)) : null;
  return { deploySlot, upgradeAuthority };
}

/** Program account (36 B): u32 tag (2), programdata address. */
export function parseProgramAccount(data: Uint8Array): string {
  if (data.length < 36) throw new Error('program account too short');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tag = view.getUint32(0, true);
  if (tag !== 2) throw new Error(`unexpected program account tag ${tag}`);
  return bs58.encode(data.subarray(4, 36));
}

export type BinaryKindName = 'v1-full' | 'v1-sunset' | 'v2-full' | 'unknown';

export function classifyBinary(
  identity: BinaryIdentity,
  known: ReadonlyArray<{ sha256: string; kind: string }>,
): BinaryKindName {
  const match = known.find((entry) => entry.sha256 === identity.sha256);
  return (match?.kind as BinaryKindName | undefined) ?? 'unknown';
}
