import { Dashboard } from '@/components/Dashboard';
import { config } from '@/lib/config';
import { getStats } from '@/lib/stats';

// DuckDB is a native module, and the figures must never come from a cache.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function Page() {
  const domains = [...config.allowedDomains];
  const domain = domains[0] ?? 'localhost';

  // Rendered on the server so the dashboard arrives populated. A loading
  // skeleton on first paint is the thing that makes an analytics tool feel
  // slow, and the data is already on this machine.
  const initial = await getStats(domain, '24h');

  return (
    <main>
      <Dashboard initial={initial} domains={domains} />
    </main>
  );
}
