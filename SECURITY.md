# Security Policy

## Reporting a vulnerability

Please report security issues privately through
[GitHub's private vulnerability reporting](https://github.com/ndunl075/Implausible/security/advisories/new)
rather than opening a public issue.

Include what you did, what happened, and what you expected. A proof of concept
helps. You can expect an initial response within 7 days.

Please do not run automated scanners against anyone else's Implausible instance,
and do not access or exfiltrate data that is not yours.

## Supported versions

v0 is pre-release; only the `main` branch receives fixes.

## Privacy issues count as security issues

Implausible's entire premise is that certain data is never collected. Report it
through the same channel if you find:

- Any path where a **raw IP address** is persisted, logged, or returned in a
  response (including error messages and stack traces).
- Any way to **link a visitor across days** — a salt that fails to rotate, a
  salt retained beyond the current-and-previous pair, or an identifier that
  survives rotation.
- Any **client-side storage** written by the tracker (cookie, `localStorage`,
  `sessionStorage`, IndexedDB, cache) or any use of a fingerprinting API.
- Any endpoint that returns **row-level event data** instead of aggregates.

These are treated with the same seriousness as an RCE, because for this project
they are the same class of failure.

## Scope notes

- Bot filtering is user-agent based and deliberately crude. Inflated counts from
  an unlisted crawler are a known limitation, not a vulnerability.
- v0 ships with no authentication by design. An instance exposed to the public
  internet without a reverse proxy in front of it is a deployment choice, not a
  bug — but report it if the dashboard leaks data no aggregate should expose.
