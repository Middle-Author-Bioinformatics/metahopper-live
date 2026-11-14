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
    <div className="project-heading"><MetaHopperBrand />{children}</div>
    <div className="account"><span title={email}>{email}</span><button onClick={onSignOut}>Sign out</button></div>
  </header>;
}
