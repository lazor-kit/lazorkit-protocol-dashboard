import { Power, ShieldAlert, ShieldCheck } from 'lucide-react';

export function ProtocolStatus({
  status,
  isLoading,
}: {
  status: 'enabled' | 'disabled' | 'not-initialized';
  isLoading: boolean;
}) {
  const Icon =
    status === 'enabled'
      ? ShieldCheck
      : status === 'disabled'
        ? Power
        : ShieldAlert;
  const label =
    status === 'enabled'
      ? 'Enabled'
      : status === 'disabled'
        ? 'Disabled'
        : 'Not initialized';

  return (
    <article className={`metricCard statusCard ${status}`}>
      <div className="metricIcon" aria-hidden="true">
        <Icon size={17} />
      </div>
      <div className="metricContent">
        <span>Protocol Status</span>
        <strong className={isLoading ? 'skeletonText' : undefined}>
          {isLoading ? 'Loading' : label}
        </strong>
        <small>Read directly from chain</small>
      </div>
    </article>
  );
}

