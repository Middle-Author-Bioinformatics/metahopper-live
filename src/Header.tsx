import type { ReactNode } from 'react';

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
  return <header className="topbar">
    <div className="company-heading">
      <img className="mab-logo" src="/mab-logo.png" alt="Middle Author Bioinformatics" />
      <div className="account">
        <span title={`Signed in as ${email}`}>{email}</span>
        <button onClick={onSignOut}>Sign out</button>
      </div>
    </div>
    <div className="project-heading">
      <MetaHopperBrand />
      {children}
    </div>
  </header>;
}
