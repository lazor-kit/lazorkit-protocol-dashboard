import { AlertTriangle } from 'lucide-react';

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  const rateLimited =
    message.toLowerCase().includes('429') ||
    message.toLowerCase().includes('rate');

  return (
    <section className="errorState">
      <AlertTriangle size={20} />
      <div>
        <h2>{rateLimited ? 'RPC rate limit reached' : 'Unable to load dashboard'}</h2>
        <p>
          {rateLimited
            ? 'Public RPC endpoints may throttle dashboard scans. Try again shortly or use a browser-safe public endpoint.'
            : message}
        </p>
      </div>
      <button type="button" className="primaryButton" onClick={onRetry}>
        Retry
      </button>
    </section>
  );
}
