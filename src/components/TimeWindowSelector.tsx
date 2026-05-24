import type { DashboardWindow } from '../solana/dashboardTypes';

const WINDOWS: { value: DashboardWindow; label: string }[] = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
];

export function TimeWindowSelector({
  window,
  onChange,
}: {
  window: DashboardWindow;
  onChange: (window: DashboardWindow) => void;
}) {
  return (
    <div className="timeWindowControl" aria-label="Time window">
      {WINDOWS.map((item) => (
        <button
          key={item.value}
          type="button"
          className={window === item.value ? 'active' : undefined}
          onClick={() => onChange(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
