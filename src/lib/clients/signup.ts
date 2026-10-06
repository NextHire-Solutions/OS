import type { MasterClient } from "./master-list";

/**
 * The client's sign-up date (client rule, 6 Oct): the FIRST $1 charge in Stripe
 * across every card it has paid with; else the date entered on the record;
 * else its first charge. Flagged when it falls after onboarding began — the
 * same day is fine.
 */
export function effectiveSignup(c: Pick<MasterClient, "stripe" | "signupDate" | "onboardingDate">): {
  date: string | null;
  source: "first $1 charge" | "entered" | "first charge" | null;
  afterOnboarding: boolean;
} {
  const st = c.stripe ?? null;
  let date: string | null = null;
  let source: "first $1 charge" | "entered" | "first charge" | null = null;
  if (st?.signupSource === "first $1 charge" && st.signupDate) { date = st.signupDate; source = "first $1 charge"; }
  else if (c.signupDate) { date = c.signupDate.slice(0, 10); source = "entered"; }
  else if (st?.signupDate) { date = st.signupDate; source = st.signupSource === "entered" ? "entered" : "first charge"; }
  const onboarding = c.onboardingDate?.slice(0, 10) ?? null;
  return { date, source, afterOnboarding: !!(date && onboarding && date > onboarding) };
}
