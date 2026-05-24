import {
  formatInteger,
  formatLamports,
  formatLamportsShort,
  shortenAddress,
} from './format.js';

describe('format helpers', () => {
  it('formats integers', () => {
    expect(formatInteger(1234567)).toBe('1,234,567');
    expect(formatInteger(123456789n)).toBe('123,456,789');
    expect(formatInteger('123456789')).toBe('123,456,789');
  });

  it('formats lamports precisely', () => {
    expect(formatLamports(0n)).toBe('0 SOL');
    expect(formatLamports(1_000_000_000n)).toBe('1 SOL');
    expect(formatLamports('1500000000')).toBe('1.5 SOL');
  });

  it('formats short lamport values', () => {
    expect(formatLamportsShort(0n)).toBe('0 SOL');
    expect(formatLamportsShort(5n)).toBe('5 lamports');
    expect(formatLamportsShort('1000000000')).toBe('1 SOL');
  });

  it('shortens addresses', () => {
    expect(shortenAddress('1234567890', 2)).toBe('12...90');
    expect(shortenAddress('1234', 2)).toBe('1234');
  });
});
