import "./signin.css";

import logo from "./logo.png";

export function SignInShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="psi">
      <div className="psi-card">
        {/* eslint-disable-next-line @next/next/no-img-element -- a fixed-size logo */}
        <img className="psi-logo" src={logo.src} alt="BrokerStaffer" />
        {children}
      </div>
    </main>
  );
}
