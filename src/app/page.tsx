export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center px-6 py-16">
      <p
        className="text-[11px] font-medium uppercase tracking-[0.18em]"
        style={{ color: 'var(--accent)' }}
      >
        Implausible
      </p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
        Privacy-first web analytics.
      </h1>
      <p
        className="mt-4 text-base leading-relaxed text-pretty"
        style={{ color: 'var(--ink-2)' }}
      >
        No cookies. No persistent identifiers. No way to follow a visitor from
        one day into the next — not because we choose not to, but because the
        data to do it is never written down.
      </p>
      <div
        className="mt-8 border-t pt-6 text-sm"
        style={{ color: 'var(--ink-3)' }}
      >
        Dashboard coming up next.
      </div>
    </main>
  );
}
