# Contributing to Implausible

Thanks for taking an interest. This project has an unusually strong opinion about
what it will not do, so please read the invariants before opening a PR.

## The invariants

Implausible's premise is that visitors are **unlinkable across days by design**.
Every one of these follows from that premise:

1. **Raw IP is never persisted or logged.** Hash at ingest, discard in the same
   function. No IP column, no IP in error messages, no IP in debug output.
2. **Salts older than 24 hours are deleted, never archived.** Only the current
   and previous salt may exist at any moment.
3. **The tracker stays under 1 KB minified.** CI fails the build otherwise. This
   is a headline claim, so it is a hard gate rather than a guideline.
4. **No cookies, no `localStorage`, no `sessionStorage`,** no client-side storage
   of any kind, no fingerprinting APIs.
5. **No metric that requires linking a visitor across days.** "Returning
   visitors", cohort retention, and per-user journeys are permanently out of
   scope. They are not hard to build; they are refused.
6. **No third-party API dependencies.** If a feature seems to need an API key,
   that feature is out of scope for this project.

A PR that trades one of these for a nicer metric will be declined, however good
the metric is. Open an issue first if you think one deserves revisiting — the
discussion is welcome, the silent erosion is not.

## Development

```bash
npm install
cp .env.example .env.local
npm run dev
```

Useful scripts:

| Command | What it does |
|---|---|
| `npm run dev` | Build the tracker, then start Next.js in dev mode |
| `npm run build` | Production build (includes the tracker size gate) |
| `npm test` | Run the test suite |
| `npm run typecheck` | TypeScript, no emit |
| `npm run lint` | ESLint |
| `npm run tracker:size` | Report the minified tracker size and fail if over budget |
| `npm run seed` | Generate realistic local data so the dashboard isn't empty |

## Pull requests

- One feature per PR; keep the diff readable.
- `npm test`, `npm run typecheck`, and `npm run lint` must pass. CI runs all three.
- Touching `tracker/src/` means you own the byte budget. `npm run tracker:size`
  prints how much headroom is left.
- Touching ingest means adding a test that proves no raw IP reaches storage.
- New dependencies need a reason in the PR description. The tracker takes none,
  ever.

## Design

The dashboard is the product. Analytics tools are judged on whether their
dashboard looks credible, so UI changes are held to the same bar as backend ones.

Implausible has its own visual identity — a dark-first instrumentation look with
hairline rules, tabular numerals, and a single warm accent. **Do not** submit
changes that move it toward the look, logo, or copy of any other analytics
product. Being an independent project is part of the point.

## Code of conduct

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
