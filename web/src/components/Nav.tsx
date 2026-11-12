"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useNearWallet } from "near-connect-hooks";
import Logo from "@/components/Logo";

function WalletButton() {
  const { signedAccountId, signIn, signOut, loading } = useNearWallet();
  if (signedAccountId)
    return (
      <button className="nav-mono on" onClick={() => signOut()} title="Disconnect">
        {signedAccountId.length > 22 ? `${signedAccountId.slice(0, 20)}…` : signedAccountId} ✕
      </button>
    );
  return (
    <button className="btn btn-sm btn-primary" disabled={loading} onClick={() => signIn()}>
      Connect NEAR wallet
    </button>
  );
}

export default function Nav() {
  const path = usePathname();
  const on = (p: string) => (path === p ? "plain on" : "plain");
  return (
    <nav className="nav calm">
      <div className="nav-inner">
        <Link className="brand" href="/">
          <Logo />
          <span>
            Air<span className="brand-dim">bag</span>
          </span>
        </Link>
        <div className="nav-right">
          <Link className={on("/")} href="/">Markets</Link>
          <Link className={on("/me")} href="/me">My cover</Link>
          <Link className={on("/proof")} href="/proof">Proof</Link>
          <WalletButton />
        </div>
      </div>
    </nav>
  );
}
