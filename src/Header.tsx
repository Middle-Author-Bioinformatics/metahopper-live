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
    <img className="mab-logo" src="/mab-logo.png" alt="Middle Author Bioinformatics" />
    <div className="project-heading">{children}</div>
    <div className="identity">
      <MetaHopperBrand />
      <div className="account">
        <span title={`Signed in as ${email}`}>{email}</span>
        <button onClick={onSignOut}>Sign out</button>
      </div>
    </div>
  </header>;
}
