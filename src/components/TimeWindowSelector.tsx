import type { DashboardWindow } from '../solana/dashboardTypes';

const WINDOWS: { value: DashboardWindow; label: string }[] = [
  { value: 'all', label: 'All history' },
  { value: '30d', label: 'Last 30 days' },
  { value: '7d', label: 'Last 7 days' },
  { value: '24h', label: 'Last 24 hours' },
];

export function TimeWindowSelector({
  window,
  onChange,
}: {
  window: DashboardWindow;
  onChange: (window: DashboardWindow) => void;
}) {
  return (
    <label className="timeWindowControl">
      <span className="srOnly">Time range</span>
      <select
        value={window}
        onChange={(event) => onChange(event.target.value as DashboardWindow)}
        aria-label="Time range"
      >
        {WINDOWS.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </select>
    </label>
  );
}
