// Small shared building blocks: address/signature links with copy, pills, section headers, bar lists, stat rows.

import { useState, type ReactNode } from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';
import type { Cluster } from '../types/dashboard';
import type { Tone } from '../app/selectors';
import { explorerAddressUrl, explorerTxUrl, formatInteger, shortenAddress } from '../lib/format';

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="miniIconButton"
      aria-label={`Copy ${label}`}
      title={copied ? 'Copied' : `Copy ${label}`}
      onClick={() => {
        try {
          void navigator.clipboard?.writeText(value).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            },
            () => undefined,
          );
        } catch {
          // clipboard unavailable (insecure context or blocked)
        }
      }}
    >
      {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
    </button>
  );
}

export function AddressLink({
  address,
  cluster,
  label = 'address',
  chars = 4,
  copy = false,
  kind = 'address',
}: {
  address: string | null | undefined;
  cluster: Cluster;
  label?: string;
  chars?: number;
  copy?: boolean;
  kind?: 'address' | 'tx';
}) {
  if (!address) return <span className="mutedText">–</span>;
  const href = kind === 'tx' ? explorerTxUrl(address, cluster) : explorerAddressUrl(address, cluster);
  return (
    <span className="addressCell">
      <a className="monoLink" href={href} target="_blank" rel="noreferrer" title={`${address} (open in Solana Explorer)`}>
        {shortenAddress(address, chars)}
        <ExternalLink size={12} aria-hidden="true" />
        <span className="srOnly">Open {label} in Solana Explorer</span>
      </a>
      {copy ? <CopyButton value={address} label={label} /> : null}
    </span>
  );
}

export function Pill({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`pill pill-${tone}`} title={title}>
      <span className="pillDot" aria-hidden="true" />
      {children}
    </span>
  );
}

export function VersionTag({ version }: { version: 1 | 2 }) {
  return (
    <span className={`versionTag versionTag-v${version}`}>
      <span className="seriesSwatch" aria-hidden="true" />v{version}
    </span>
  );
}

export function SectionHeader({ eyebrow, title, aside, id }: { eyebrow: string; title: string; aside?: ReactNode; id?: string }) {
  return (
    <div className="panelHeader">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2 id={id}>{title}</h2>
      </div>
      {aside ? <div className="panelAside">{aside}</div> : null}
    </div>
  );
}

export interface BarItem {
  key: string;
  label: ReactNode;
  value: number;
  detail?: ReactNode;
  title?: string;
}

/** A horizontal bar list: label, a bar proportional to the largest value, the value. Text never wears the bar color. */
export function BarList({ items, empty = 'No activity in this window', unit }: { items: BarItem[]; empty?: string; unit?: string }) {
  if (items.length === 0) return <p className="emptyLine">{empty}</p>;
  const max = Math.max(1, ...items.map((item) => item.value));
  return (
    <ul className="barList">
      {items.map((item) => (
        <li key={item.key} title={item.title}>
          <div className="barListText">
            <span className="barListLabel">{item.label}</span>
            <span className="barListValue">
              {formatInteger(item.value)}
              {unit ? <span className="mutedText"> {unit}</span> : null}
              {item.detail ? <span className="barListDetail">{item.detail}</span> : null}
            </span>
          </div>
          <div className="barTrack" aria-hidden="true">
            <div style={{ width: `${Math.max(2, (item.value / max) * 100)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function StatRow({ label, value, title, hint }: { label: string; value: ReactNode; title?: string; hint?: ReactNode }) {
  return (
    <div className="statRow">
      <dt>{label}</dt>
      <dd title={title}>
        {value}
        {hint ? <span className="statHint">{hint}</span> : null}
      </dd>
    </div>
  );
}
