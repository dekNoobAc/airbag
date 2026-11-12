import type { Metadata } from "next";
import "./globals.css";
import Nav from "@/components/Nav";
import { Providers } from "@/components/providers";

export const metadata: Metadata = {
  title: "Airbag: insure what Polymarket predicts",
  description:
    "Cover for crypto events, sold from an AMM on NEAR. Never cheaper than Polymarket's odds (read inside a TEE), fully backed, paid out automatically on NEAR or Base.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <Providers>
          <Nav />
          {children}
          <footer className="footer">
            <div className="footer-inner container">
              <span>Airbag · NEAR testnet · prices floored by Polymarket, read in an OutLayer TEE</span>
              <a href="/proof">Proof →</a>
            </div>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
