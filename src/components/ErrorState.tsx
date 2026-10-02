import { AlertTriangle } from 'lucide-react';

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <section className="errorState" role="alert">
      <AlertTriangle size={20} aria-hidden="true" />
      <div>
        <h2>Unable to load the dashboard</h2>
        <p>{message}</p>
      </div>
      {onRetry ? (
        <button type="button" className="primaryButton" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </section>
  );
}
