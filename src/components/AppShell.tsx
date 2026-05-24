import type { ReactNode } from 'react';

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="appShell">
      <main className="dashboard">{children}</main>
    </div>
  );
}
