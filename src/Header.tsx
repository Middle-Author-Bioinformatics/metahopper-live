import type { ReactNode } from 'react';
import { useTheme } from './ThemeProvider';

export function MetaHopperBrand() {
  return <div className="metahopper-brand">
    <img className="hopper-mark" src="/metahopper-mark.png" alt="" aria-hidden="true" />
    <h1>MetaHopper</h1>
  </div>;
}

export default function Header({ email, onSignOut, children }: {
  email: string;
  onSignOut?: () => void;
  children?: ReactNode;
}) {
  const { theme, setTheme } = useTheme();
  return <header className="topbar">
    <div className="company-heading">
      <img className="mab-logo" src="/mab-logo.png" alt="Middle Author Bioinformatics" />
    </div>
    <MetaHopperBrand />
    <div className="project-heading">
      <div className="project-controls">
        {children}
        <button className="theme-toggle" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
            {theme === 'dark' ? <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></> : <path d="M20.5 14A8.5 8.5 0 0 1 10 3.5 8.5 8.5 0 1 0 20.5 14Z" />}
          </svg>
          {theme === 'dark' ? 'Light' : 'Dark'}
        </button>
      </div>
      <div className="account">
        <span title={`Signed in as ${email}`}>{email}</span>
        <button onClick={onSignOut}>Sign out</button>
      </div>
    </div>
  </header>;
}
