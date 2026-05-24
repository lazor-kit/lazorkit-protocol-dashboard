import type { ReactNode } from 'react';

export function AppShell({
  actions,
  children,
}: {
  actions: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="appShell">
      <header className="topNav">
        <div className="brand">
          <img src="/lazorkit-logo.png" alt="LazorKit" />
          <div>
            <p>LazorKit</p>
            <span>Public Analytics</span>
          </div>
        </div>
        <div className="topActions">{actions}</div>
      </header>
      <main className="dashboard">{children}</main>
    </div>
  );
}
