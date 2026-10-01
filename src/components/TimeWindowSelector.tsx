import type { DashboardWindow } from '../types/dashboard';

const WINDOWS: Array<{ value: DashboardWindow; label: string }> = [
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'all', label: 'All history' },
];

export function TimeWindowSelector({ window, onChange }: { window: DashboardWindow; onChange: (window: DashboardWindow) => void }) {
  return (
    <label className="selectControl">
      <span className="srOnly">Time range</span>
      <select value={window} onChange={(event) => onChange(event.target.value as DashboardWindow)} aria-label="Time range">
        {WINDOWS.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </select>
    </label>
  );
}
