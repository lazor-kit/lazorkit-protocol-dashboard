import { Info } from 'lucide-react';
import { FAIL_CLASS_DEFINITIONS } from '../types/protocol';
import { FAIL_LABELS } from '../app/selectors';
import type { FailClass } from '../types/dashboard';

/** One definition per figure on the page (spec §8). */
export const METRIC_NOTES: Array<{ term: string; definition: string }> = [
  {
    term: 'Transactions',
    definition:
      'Signatures with at least one real LazorKit instruction (top level or called by another program), split into successful and failed. A transaction carrying both a v1 and a v2 instruction counts once in the all-versions total.',
  },
  {
    term: 'Success rate / protocol error rate',
    definition: 'Successful transactions ÷ transactions; transactions that failed with a LazorKit error ÷ transactions.',
  },
  {
    term: 'Active wallets',
    definition:
      'Distinct wallets in successful wallet operations (create, authority changes, execute, sessions, authorize, deferred execute, migrate). Each wallet counts once per window; v1 and v2 wallets are different accounts, so the total is v1 + v2.',
  },
  { term: 'Wallets created', definition: 'Successful CreateWallet instructions; passkey share = those whose owner is a passkey.' },
  {
    term: 'Protocol fees',
    definition:
      'Lamports moved by the System transfer from the payer to one of the program’s own treasury shards inside a successful CreateWallet, Execute or ExecuteDeferred. Any other transfer counts 0. Average = fees ÷ fee-paying events.',
  },
  {
    term: 'Unwithdrawn fees / withdrawable now',
    definition:
      'Fees minus withdrawals, from history; versus the shard balances above the rent-exempt minimum, from chain state. They differ by the rent that became excess when rent fell in 2026.',
  },
  {
    term: 'Wallets existing / vault SOL',
    definition:
      'Current on-chain accounts, from a getProgramAccounts snapshot taken on every indexer run. Vault SOL is native SOL only; token balances are not included.',
  },
  { term: 'Relayers', definition: 'Distinct fee payers of successful operations; network fees are the Solana transaction fees they paid.' },
  {
    term: 'Integrators',
    definition: 'The passkey rpId at wallet creation, or the WebAuthn origin of later passkey operations, normalised to a host name.',
  },
  { term: 'Transaction v1 (SIMD-0385)', definition: 'Real transactions sent with message version 1 (v2 devnet only so far).' },
  { term: 'Migrations', definition: 'Successful MigrateWallet instructions on the v1 program; possible only once v1 runs the sunset build.' },
  {
    term: 'Time ranges',
    definition:
      'All times are UTC. 24 hours = the last 24 hours, by hour, the newest one partial. 7 and 30 days = whole UTC days including today so far. The comparison covers the same span one period earlier: it ends exactly 24 hours, 7 days or 30 days before now, so a partly elapsed hour or day is compared with the same part of the hour or day before. All history starts at each program’s deploy transaction.',
  },
  {
    term: 'Data complete through',
    definition:
      'Every transaction of every deployed program up to this time has been ingested. The request time is never shown as “last updated”.',
  },
];

export function DataNotes() {
  return (
    <section className="dataNotes" aria-labelledby="data-notes-title">
      <div className="noteIcon" aria-hidden="true">
        <Info size={15} />
      </div>
      <div>
        <h3 id="data-notes-title">Data notes</h3>
        <dl className="notesList">
          {METRIC_NOTES.map((note) => (
            <div key={note.term}>
              <dt>{note.term}</dt>
              <dd>{note.definition}</dd>
            </div>
          ))}
          <div>
            <dt>Failure classes</dt>
            <dd>
              <ul>
                {(Object.keys(FAIL_LABELS) as FailClass[]).map((klass) => (
                  <li key={klass}>
                    <strong>{FAIL_LABELS[klass]}</strong>: {FAIL_CLASS_DEFINITIONS[klass]}
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
