// Chain constants vs the published SDKs, PDAs vs live accounts (gPA fixtures), binary identification vs the
// dumped programs.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import * as sdkV1 from '@lazorkit/sdk-legacy-v1';
import * as sdkV2 from '@lazorkit/sdk-legacy-v2';
import bs58 from 'bs58';
import { ACCOUNT_DISC_V1, ACCOUNT_DISC_V2, IX } from './constants.js';
import { classifyBinary, elfBound, identifyElf, parseProgramAccount, parseProgramdataHeader } from './binary.js';
import { canonicalShardSet, protocolConfigPda, treasuryShardPda } from './pdas.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', '__fixtures__');

function gpa(name: string): { slot: number; list: Array<{ pubkey: string; lamports: number; data: string }> } {
  return JSON.parse(gunzipSync(readFileSync(join(fixtures, 'gpa', `${name}.json.gz`))).toString('utf8'));
}

function binary(name: string): Uint8Array {
  return new Uint8Array(gunzipSync(readFileSync(join(fixtures, 'bin', `${name}.so.gz`))));
}

const V1_MAINNET = 'LazorjRFNavitUaBu5m3WaNPjU1maipvSW2rZfAFAKi';
const V1_DEVNET = '4h3XoNReAgEcHVxcZ8sw2aufi9MTr7BbvYYjzjWDyDxS';
const V2_DEVNET = '57bTNWqtYTJbWuLWASKo6GqUTAK6oFDUR5c6hEc6V8nv';
const V2_MAINNET = 'LazorFroiVuAjcwwQ2me83vTr5nc5NRxSaTg3pmEXC8';

describe('SDK conformance', () => {
  it('instruction tags 0-14 and 17 equal the v2 SDK DISC_* exports, 0-14 the v1 SDK', () => {
    const v2 = sdkV2 as unknown as Record<string, number>;
    const v1 = sdkV1 as unknown as Record<string, number>;
    const names: Array<[keyof typeof IX, string]> = [
      ['CreateWallet', 'DISC_CREATE_WALLET'], ['AddAuthority', 'DISC_ADD_AUTHORITY'], ['RemoveAuthority', 'DISC_REMOVE_AUTHORITY'],
      ['TransferOwnership', 'DISC_TRANSFER_OWNERSHIP'], ['Execute', 'DISC_EXECUTE'], ['CreateSession', 'DISC_CREATE_SESSION'],
      ['Authorize', 'DISC_AUTHORIZE'], ['ExecuteDeferred', 'DISC_EXECUTE_DEFERRED'], ['ReclaimDeferred', 'DISC_RECLAIM_DEFERRED'],
      ['RevokeSession', 'DISC_REVOKE_SESSION'], ['InitializeProtocol', 'DISC_INITIALIZE_PROTOCOL'],
      ['UpdateProtocol', 'DISC_UPDATE_PROTOCOL'], ['RegisterPayer', 'DISC_REGISTER_PAYER'],
      ['WithdrawTreasury', 'DISC_WITHDRAW_TREASURY'], ['InitializeTreasuryShard', 'DISC_INITIALIZE_TREASURY_SHARD'],
    ];
    for (const [local, sdkName] of names) {
      expect(v2[sdkName], sdkName).toBe(IX[local]);
      expect(v1[sdkName], sdkName).toBe(IX[local]);
    }
    expect(v2.DISC_MIGRATE_WALLET).toBe(IX.MigrateWallet);
  });

  it('15, 16 and 18 (not re-exported by the v2 SDK index) match the SDK source and u3 §4.1', () => {
    const require = createRequire(import.meta.url);
    const dist = join(dirname(require.resolve('@lazorkit/sdk-legacy-v2')), 'utils', 'instructions.d.ts');
    const text = readFileSync(dist, 'utf8');
    const value = (name: string) => Number(new RegExp(`${name} = (\\d+)`).exec(text)?.[1]);
    expect(value('DISC_PROPOSE_PROTOCOL_ADMIN')).toBe(IX.ProposeAdminRotation);
    expect(value('DISC_ACCEPT_PROTOCOL_ADMIN')).toBe(IX.AcceptAdminRotation);
    expect(value('DISC_CLOSE_EXPIRED_SESSION')).toBe(IX.CloseExpiredSession);
    expect([IX.ProposeAdminRotation, IX.AcceptAdminRotation, IX.CloseExpiredSession]).toEqual([15, 16, 18]);
  });

  it('account discriminators equal the SDK constants (v2 ACCOUNT_DISCRIMINATOR, v1 V1_DISC_*)', () => {
    expect({
      wallet: sdkV2.ACCOUNT_DISCRIMINATOR.WALLET,
      authority: sdkV2.ACCOUNT_DISCRIMINATOR.AUTHORITY,
      session: sdkV2.ACCOUNT_DISCRIMINATOR.SESSION,
      deferred: sdkV2.ACCOUNT_DISCRIMINATOR.DEFERRED_EXEC,
      protocolConfig: sdkV2.ACCOUNT_DISCRIMINATOR.PROTOCOL_CONFIG,
      feeRecord: sdkV2.ACCOUNT_DISCRIMINATOR.FEE_RECORD,
      treasuryShard: sdkV2.ACCOUNT_DISCRIMINATOR.TREASURY_SHARD,
    }).toEqual(ACCOUNT_DISC_V2);
    expect([sdkV2.V1_DISC_WALLET, sdkV2.V1_DISC_AUTHORITY, sdkV2.V1_DISC_SESSION, sdkV2.V1_DISC_DEFERRED_EXEC]).toEqual([
      ACCOUNT_DISC_V1.wallet, ACCOUNT_DISC_V1.authority, ACCOUNT_DISC_V1.session, ACCOUNT_DISC_V1.deferred,
    ]);
    expect(ACCOUNT_DISC_V1).toMatchObject({ protocolConfig: 5, feeRecord: 6, treasuryShard: 7 });
  });
});

describe('PDAs vs live accounts', () => {
  for (const [name, programId, version, disc] of [
    ['gpa-mainnet-Lazorj', V1_MAINNET, 1, 7],
    ['gpa-devnet-4h3XoN', V1_DEVNET, 1, 7],
  ] as const) {
    it(`treasury shards 0..15 of ${name} are the canonical PDAs`, () => {
      const shards = gpa(name).list.filter((a) => Buffer.from(a.data, 'base64')[0] === disc);
      expect(shards).toHaveLength(16);
      const derived = new Set(Array.from({ length: 16 }, (_, id) => treasuryShardPda(version, programId, id)));
      for (const shard of shards) {
        expect(derived.has(shard.pubkey)).toBe(true);
        const id = Buffer.from(shard.data, 'base64')[2];
        expect(treasuryShardPda(version, programId, id)).toBe(shard.pubkey);
      }
      expect(canonicalShardSet(version, programId).size).toBe(256);
    });
  }

  it('config PDAs equal the live config accounts', () => {
    const mainnetConfig = gpa('gpa-mainnet-Lazorj').list.find((a) => Buffer.from(a.data, 'base64')[0] === 5);
    const devnetConfig = gpa('gpa-devnet-4h3XoN').list.find((a) => Buffer.from(a.data, 'base64')[0] === 5);
    expect(protocolConfigPda(1, V1_MAINNET)).toBe(mainnetConfig?.pubkey);
    expect(protocolConfigPda(1, V1_DEVNET)).toBe(devnetConfig?.pubkey);
    expect(protocolConfigPda(1, V1_MAINNET)).toBe('8mnK3NDPKJEgwDnq2h73sEbdPAvtMrGXaTZimsG5wzeA');
    expect(protocolConfigPda(2, V2_MAINNET)).toBe('HuXCV7DB38jJJPosQTYwvMiaMfQGoUPN194z5ftMhrYr');
    expect(protocolConfigPda(2, V2_DEVNET).startsWith('Fcpys6uE')).toBe(true);
    expect(gpa('gpa-devnet-57bTNW').list.some((a) => Buffer.from(a.data, 'base64')[0] === 0x25)).toBe(false);
  });
});

describe('binary identification', () => {
  const known = [
    { sha256: '8ad5abf5dd8a2443fea6b26b5effa9ce11477ce85ba9564f5c43663744c3255b', kind: 'v1-full' },
    { sha256: '2bc794a82f91fb91ecf4a55fbb424ea6e72ef87fb9a752ee809a05d5180029c7', kind: 'v1-full' },
    { sha256: '3584aec70e494e27521bf3e717ccc63bda295bb9d312cdcd4f9a007db249b470', kind: 'v2-full' },
  ];

  it('hashes the header-bounded ELF of the three live programs', () => {
    expect(identifyElf(binary('mainnet-v1'))).toEqual({ sha256: known[0].sha256, elfSize: 137904 });
    expect(identifyElf(binary('devnet-v1'))).toEqual({ sha256: known[1].sha256, elfSize: 161568 });
    // devnet v2: 160,560 B of programdata, the ELF ends at 150,776 B, then a zero tail from ExtendProgram
    const v2 = binary('devnet-v2');
    expect(v2.length).toBe(160560);
    expect(identifyElf(v2)).toEqual({ sha256: known[2].sha256, elfSize: 150776 });
    expect(classifyBinary(identifyElf(v2), known)).toBe('v2-full');
  });

  it('a random tail after the ELF does not change the hash; an unknown hash classifies as unknown', () => {
    const elf = binary('mainnet-v1');
    const padded = new Uint8Array(elf.length + 5000);
    padded.set(elf);
    for (let i = elf.length; i < padded.length; i += 1) padded[i] = (i * 7919) & 0xff;
    expect(identifyElf(padded).sha256).toBe(known[0].sha256);
    expect(elfBound(padded)).toBe(137904);
    const tampered = elf.slice();
    tampered[5000] ^= 0xff;
    expect(classifyBinary(identifyElf(tampered), known)).toBe('unknown');
  });

  it('decodes the program account and the programdata header', () => {
    const programdata = '8DCUYd3QnTQMxARCFnd5xMwJuVekMZEZTB45z9zC2SZb'; // v1 mainnet programdata
    const program = new Uint8Array(36);
    program[0] = 2;
    program.set(bs58.decode(programdata), 4);
    expect(parseProgramAccount(program)).toBe(programdata);
    program[0] = 3;
    expect(() => parseProgramAccount(program)).toThrow('unexpected program account tag');
    const header = new Uint8Array(45);
    header[0] = 3;
    new DataView(header.buffer).setBigUint64(4, 416478802n, true);
    header[12] = 1;
    header.fill(9, 13, 45);
    expect(parseProgramdataHeader(header)).toMatchObject({ deploySlot: 416478802 });
    expect(parseProgramdataHeader(header).upgradeAuthority).not.toBeNull();
    header[12] = 0;
    expect(parseProgramdataHeader(header).upgradeAuthority).toBeNull();
    expect(() => elfBound(new Uint8Array(100))).toThrow('not an ELF');
  });
});
