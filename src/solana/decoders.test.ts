import { PublicKey } from '@solana/web3.js';
import {
  decodeFeeRecord,
  decodeProtocolConfig,
  decodeTreasuryShard,
} from './decoders';

function writeU64(data: Uint8Array, offset: number, value: bigint) {
  new DataView(data.buffer).setBigUint64(offset, value, true);
}

function writeU32(data: Uint8Array, offset: number, value: number) {
  new DataView(data.buffer).setUint32(offset, value, true);
}

describe('account decoders', () => {
  it('decodes ProtocolConfig at fixed offsets', () => {
    const admin = PublicKey.unique();
    const treasury = PublicKey.unique();
    const data = new Uint8Array(88);
    data[0] = 5;
    data[1] = 1;
    data[2] = 254;
    data[3] = 1;
    data[4] = 16;
    data.set(admin.toBytes(), 8);
    data.set(treasury.toBytes(), 40);
    writeU64(data, 72, 5000n);
    writeU64(data, 80, 2000n);

    const decoded = decodeProtocolConfig(data);
    expect(decoded.enabled).toBe(true);
    expect(decoded.numShards).toBe(16);
    expect(decoded.admin.toBase58()).toBe(admin.toBase58());
    expect(decoded.treasury.toBase58()).toBe(treasury.toBase58());
    expect(decoded.creationFee).toBe(5000n);
    expect(decoded.executionFee).toBe(2000n);
  });

  it('decodes FeeRecord at fixed offsets', () => {
    const data = new Uint8Array(32);
    data[0] = 6;
    data[1] = 7;
    data[2] = 1;
    writeU64(data, 8, 12_345n);
    writeU32(data, 16, 9);
    writeU32(data, 20, 3);
    writeU64(data, 24, 1234n);

    const decoded = decodeFeeRecord(data);
    expect(decoded.totalFeesPaid).toBe(12_345n);
    expect(decoded.txCount).toBe(9);
    expect(decoded.walletCount).toBe(3);
    expect(decoded.registeredAt).toBe(1234n);
  });

  it('decodes TreasuryShard and rejects malformed data', () => {
    const data = new Uint8Array(8);
    data[0] = 7;
    data[1] = 99;
    data[2] = 4;

    expect(decodeTreasuryShard(data)).toMatchObject({
      discriminator: 7,
      bump: 99,
      shardId: 4,
    });
    expect(() => decodeTreasuryShard(new Uint8Array([6]))).toThrow();
  });
});

