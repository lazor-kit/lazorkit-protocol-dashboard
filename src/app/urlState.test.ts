import { defaultCluster, parseUrlState, serializeUrlState } from './urlState';

describe('URL state', () => {
  it('parses valid values and falls back on anything else', () => {
    expect(parseUrlState('?cluster=devnet&window=7d&version=2', 'mainnet')).toEqual({ cluster: 'devnet', window: '7d', version: '2' });
    expect(parseUrlState('', 'mainnet')).toEqual({ cluster: 'mainnet', window: '30d', version: 'all' });
    expect(parseUrlState('cluster=localnet&window=90d&version=3', 'devnet')).toEqual({ cluster: 'devnet', window: '30d', version: 'all' });
  });

  it('serializes every key and keeps unrelated parameters', () => {
    expect(serializeUrlState({ cluster: 'mainnet', window: 'all', version: '1' })).toBe('?cluster=mainnet&window=all&version=1');
    expect(serializeUrlState({ cluster: 'devnet', window: '24h', version: 'all' }, '?utm=x&cluster=mainnet')).toBe(
      '?utm=x&cluster=devnet&window=24h&version=all',
    );
  });

  it('round-trips', () => {
    const state = { cluster: 'devnet', window: '7d', version: '2' } as const;
    expect(parseUrlState(serializeUrlState(state), 'mainnet')).toEqual(state);
  });

  it('reads the default cluster from VITE_DEFAULT_CLUSTER', () => {
    expect(defaultCluster('devnet')).toBe('devnet');
    expect(defaultCluster(undefined)).toBe('mainnet');
    expect(defaultCluster('localnet')).toBe('mainnet');
  });
});
