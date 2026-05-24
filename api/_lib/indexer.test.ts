import { dedupeProtocolTransactionRows } from './indexer';
import type { ProtocolTransactionRow } from './database';

function row(signature: string, slot: number): ProtocolTransactionRow {
  return {
    cluster: 'mainnet',
    signature,
    slot,
    block_time: '2026-05-24T00:00:00.000Z',
    fee_payer: 'payer',
    wallet_pda: 'wallet',
    method: 'Execute',
    status: 'success',
    protocol_fee_lamports: '1',
    treasury_shard: null,
    fee_record: null,
    instruction_index: 0,
    parse_warnings: [],
  };
}

describe('indexer helpers', () => {
  it('deduplicates rows by cluster and signature before upsert', () => {
    expect(
      dedupeProtocolTransactionRows([
        row('same', 1),
        row('same', 2),
        { ...row('same', 3), cluster: 'devnet' },
      ]),
    ).toEqual([row('same', 2), { ...row('same', 3), cluster: 'devnet' }]);
  });
});
