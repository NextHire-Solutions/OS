import { getAllSnapshots } from "@/lib/status/store";
import { Dashboard } from "@/components/home/dashboard";

/*
 * Server-renders from the same store the API route uses, so the first paint
 * already carries real numbers — no client waterfall, and the page is useful
 * before any JavaScript runs.
 */
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const snapshots = await getAllSnapshots();

  return (
    <Dashboard
      initial={{ snapshots, generatedAt: new Date().toISOString() }}
    />
  );
}
