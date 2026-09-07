import { Suspense } from "react";
import type { Metadata } from "next";
import { RailBrand } from "@/components/shell/rail-brand";
import { LoginForm } from "@/components/auth/login-form";

export const metadata: Metadata = { title: "Sign in — BrokerStaffer" };

/*
 * Sign-in, drawn with the workspace's own design system.
 *
 * It used to be styled with Tailwind utilities, and broke the moment the
 * design's stylesheet went in: that sheet carries a global reset
 * (`*{margin:0;padding:0}`) and its own body rules, so the page lost every
 * scrap of spacing and the card collapsed onto its fields.
 *
 * Rewriting it in the design's classes rather than re-isolating Tailwind is the
 * better fix — this is the first screen anyone sees, and it should look like
 * the product rather than like a page that predates it.
 *
 * The `.app` class is deliberately not used: it is an absolutely positioned
 * two-column shell for the workspace, and there is no rail here.
 */
export default function LoginPage() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: 24,
        background: "var(--page)",
      }}
    >
      <div style={{ width: "100%", maxWidth: 380 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            gap: 11,
            color: "var(--logo)",
            marginBottom: 22,
          }}
        >
          <RailBrand />
        </div>

        <div className="card" style={{ padding: "26px 26px 24px" }}>
          <h1 style={{ fontSize: 19, fontWeight: 600, letterSpacing: "-.02em", color: "var(--ink)" }}>
            Sign in
          </h1>
          <p style={{ fontSize: 13.5, color: "var(--muted)", marginTop: 6, lineHeight: 1.55 }}>
            One sign-in for every BrokerStaffer tool.
          </p>

          <Suspense fallback={null}>
            <LoginForm />
          </Suspense>
        </div>
      </div>
    </main>
  );
}
