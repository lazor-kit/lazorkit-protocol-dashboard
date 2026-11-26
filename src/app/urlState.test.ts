import { defaultCluster, parseUrlState, serializeUrlState } from './urlState';

describe('URL state', () => {
  it('parses the cluster and time window, including old shared links', () => {
    expect(parseUrlState('?cluster=devnet&window=7d&version=2', 'mainnet')).toEqual({ cluster: 'devnet', window: '7d' });
    expect(parseUrlState('', 'mainnet')).toEqual({ cluster: 'mainnet', window: '30d' });
    expect(parseUrlState('cluster=localnet&window=90d', 'devnet')).toEqual({ cluster: 'devnet', window: '30d' });
  });

  it('removes the old version filter and keeps unrelated parameters', () => {
    expect(serializeUrlState({ cluster: 'devnet', window: '24h' }, '?utm=x&cluster=mainnet&version=all')).toBe(
      '?utm=x&cluster=devnet&window=24h',
    );
  });

  it('round-trips', () => {
    const state = { cluster: 'devnet', window: '7d' } as const;
    expect(parseUrlState(serializeUrlState(state), 'mainnet')).toEqual(state);
  });

  it('reads the default cluster from VITE_DEFAULT_CLUSTER', () => {
    expect(defaultCluster('devnet')).toBe('devnet');
    expect(defaultCluster(undefined)).toBe('mainnet');
    expect(defaultCluster('localnet')).toBe('mainnet');
  });
});
