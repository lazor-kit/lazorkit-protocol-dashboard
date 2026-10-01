import type { VersionFilter as Version } from '../app/urlState';

const OPTIONS: Array<{ id: Version; label: string; title: string }> = [
  { id: 'all', label: 'All', title: 'Both protocol versions (cluster totals)' },
  { id: '1', label: 'v1', title: 'Protocol v1 only' },
  { id: '2', label: 'v2', title: 'Protocol v2 only' },
];

export function VersionFilter({ version, onChange }: { version: Version; onChange: (version: Version) => void }) {
  return (
    <div className="segmented" role="radiogroup" aria-label="Protocol version">
      {OPTIONS.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={version === option.id}
          title={option.title}
          className={version === option.id ? 'active' : undefined}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
