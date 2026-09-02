import { Suspense } from "react";
import type { Metadata } from "next";
import { BrandMark } from "@/components/layout/brand-mark";
import { LoginForm } from "@/components/auth/login-form";

export const metadata: Metadata = { title: "Sign in — BrokerStaffer" };

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-[360px]">
        <div className="flex justify-center">
          <BrandMark className="h-8 w-auto" />
        </div>

        <div className="mt-8 rounded-xl border border-border bg-surface p-6 shadow-card">
          <h1 className="text-[17px] font-semibold tracking-[-0.01em]">Sign in</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Command Center for the BrokerStaffer stack.
          </p>

          <Suspense fallback={null}>
            <LoginForm />
          </Suspense>
        </div>
      </div>
    </main>
  );
}
