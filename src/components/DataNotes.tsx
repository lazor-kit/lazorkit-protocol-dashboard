import { Info } from 'lucide-react';

export function DataNotes() {
  return (
    <section className="dataNotes" aria-label="Data notes">
      <div className="noteIcon" aria-hidden="true">
        <Info size={15} />
      </div>
      <div>
        <h2>Data notes</h2>
        <ul>
          <li>
            Lifetime fees recorded are cumulative FeeRecord counters and do not
            decrease after treasury withdrawals.
          </li>
          <li>
            Currently collectible fees are treasury shard balances minus the
            rent reserve needed to keep shard accounts alive.
          </li>
          <li>
            FeeRecord PDAs are not payer addresses. The current FeeRecord layout
            stores counters only; the payer pubkey is a PDA seed and cannot be
            recovered from account data.
          </li>
        </ul>
      </div>
    </section>
  );
}
