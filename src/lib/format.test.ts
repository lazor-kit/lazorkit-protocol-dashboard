import {
  explorerAddressUrl,
  explorerTxUrl,
  formatAge,
  formatDuration,
  formatLamports,
  formatPercent,
  formatSolAxis,
  formatUtc,
  percentChange,
  shortenAddress,
} from './format';

describe('formatLamports', () => {
  it('shows lamports below 0.001 SOL and SOL with at most 4 decimals above', () => {
    expect(formatLamports('0')).toBe('0 SOL');
    expect(formatLamports('5000')).toBe('5,000 lamports');
    expect(formatLamports('930000')).toBe('930,000 lamports');
    expect(formatLamports('999999')).toBe('999,999 lamports');
    expect(formatLamports('1000000')).toBe('0.001 SOL');
    expect(formatLamports('2215000')).toBe('0.0022 SOL');
    expect(formatLamports('6305880')).toBe('0.0063 SOL');
    expect(formatLamports('5934333867')).toBe('5.9343 SOL');
    expect(formatLamports('72280712197')).toBe('72.2807 SOL');
    expect(formatLamports('1000000000')).toBe('1 SOL');
    expect(formatLamports('1234567890123456789')).toBe('1,234,567,890.1235 SOL');
  });

  it('handles negatives, bigints, numbers and bad input', () => {
    expect(formatLamports('-2000')).toBe('−2,000 lamports');
    expect(formatLamports(-4_090_880n)).toBe('−0.0041 SOL');
    expect(formatLamports(15_144_960)).toBe('0.0151 SOL');
    expect(formatLamports('not a number')).toBe('0 SOL');
    expect(formatLamports(null)).toBe('–');
  });
});

describe('times', () => {
  const now = Date.parse('2026-10-01T19:17:00Z');
  it('prints UTC, with the date only when it is not today', () => {
    expect(formatUtc('2026-10-01T18:58:41.508+00:00', now)).toBe('18:58 UTC');
    expect(formatUtc('2026-09-27T17:14:11Z', now)).toBe('2026-09-27 17:14 UTC');
    expect(formatUtc('2026-10-01T18:58:41Z', now, { alwaysDate: true, seconds: true })).toBe('2026-10-01 18:58:41 UTC');
    expect(formatUtc(null, now)).toBe('–');
  });

  it('prints relative ages', () => {
    expect(formatAge('2026-10-01T19:16:40Z', now)).toBe('just now');
    expect(formatAge('2026-10-01T18:39:00Z', now)).toBe('38 min ago');
    expect(formatAge('2026-10-01T10:17:00Z', now)).toBe('9 h ago');
    expect(formatAge('2026-10-01T17:59:00Z', now)).toBe('1.3 h ago');
    expect(formatAge('2026-09-27T17:14:11Z', now)).toBe('4 days ago');
    expect(formatAge('2026-10-02T00:00:00Z', now)).toBe('just now');
  });

  it('prints durations', () => {
    expect(formatDuration(3_509)).toBe('4 s');
    expect(formatDuration(39 * 60_000 + 8_000)).toBe('39 min 8 s');
    expect(formatDuration(2 * 3600_000 + 5 * 60_000)).toBe('2 h 5 min');
    expect(formatDuration(null)).toBe('–');
  });
});

describe('misc', () => {
  it('builds explorer links with the devnet parameter only on devnet', () => {
    expect(explorerTxUrl('sig', 'mainnet')).toBe('https://explorer.solana.com/tx/sig');
    expect(explorerTxUrl('sig', 'devnet')).toBe('https://explorer.solana.com/tx/sig?cluster=devnet');
    expect(explorerAddressUrl('addr', 'devnet')).toBe('https://explorer.solana.com/address/addr?cluster=devnet');
  });

  it('formats percentages, changes, axis ticks and addresses', () => {
    expect(formatPercent(1)).toBe('100%');
    expect(formatPercent(0.39016)).toBe('39%');
    expect(formatPercent(0.0004)).toBe('<0.1%');
    expect(formatPercent(null)).toBe('–');
    expect(percentChange(10, 5)).toBe(1);
    expect(percentChange(0, 0)).toBe(0);
    expect(percentChange(3, null)).toBeNull();
    expect(formatSolAxis(0.0002, 4)).toBe('0.0002');
    expect(formatSolAxis(0, 4)).toBe('0');
    expect(shortenAddress('LazorjRFNavitUaBu5m3WaNPjU1maipvSW2rZfAFAKi')).toBe('Lazo…FAKi');
  });
});
