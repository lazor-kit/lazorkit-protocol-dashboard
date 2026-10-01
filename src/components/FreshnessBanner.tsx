import { AlertTriangle, CloudOff, Info, Wrench } from 'lucide-react';
import type { BannerModel } from '../app/selectors';
import { CopyButton } from './ui';

const ICONS = { info: Info, warning: AlertTriangle, danger: CloudOff, good: Info, neutral: Info } as const;

/** Freshness banner (spec §10.3): blue catching up, amber delayed / setup required, red stale / unavailable. */
export function FreshnessBanner({ banner }: { banner: BannerModel }) {
  const Icon = banner.state === 'setup_required' ? Wrench : ICONS[banner.tone];
  return (
    <section
      className={`banner banner-${banner.tone}`}
      role={banner.tone === 'danger' ? 'alert' : 'status'}
      aria-label={`Data status: ${banner.label}`}
    >
      <Icon size={18} aria-hidden="true" className="bannerIcon" />
      <div className="bannerBody">
        <strong className="bannerLabel">{banner.label}</strong>
        {banner.messages.map((message) => (
          <p key={message}>{message}</p>
        ))}
        {banner.command ? (
          <p className="bannerCommand">
            <code>{banner.command}</code>
            <CopyButton value={banner.command} label="command" />
          </p>
        ) : null}
      </div>
    </section>
  );
}
