# Security policy

Security fixes target the current source on `main`. Older client archives are
historical, immutable downloads; their presence does not imply ongoing security
support. Use the newest supported client release and review release notes before
connecting to a deployment.

## Reporting a vulnerability

Use the repository's **Security → Report a vulnerability** option when it is
available: [private vulnerability reporting](https://github.com/wick-cloud/meta-hackathon-wick/security/advisories/new).
If private reporting has not been enabled, ask a maintainer in a public issue to
provide a private reporting channel without including vulnerability details,
credentials, customer data, or exploit payloads. Maintainers must enable private
reporting before inviting public security reports.

Include the affected commit/client version, prerequisites, a minimal reproduction
using synthetic accounts and data, the observed impact, and any proposed fix.
Do not probe hosted customer accounts or allocate paid provider resources without
the operator's explicit authorization. There is no published response-time or
bug-bounty commitment.

## Credentials and incident response

Keep deployment credentials in the operator's secret store or an ignored local
environment file. Never include them in issues, PR descriptions, recordings,
screenshots, terminal captures, test reports, or release archives. Seed and CI
passwords are synthetic and must never be reused for a real deployment.

If a real credential is exposed, revoke or rotate it at its issuing service first.
Check access logs and affected resources, then remove the exposure from the
current tree, reachable Git history, build artifacts, and release attachments as
appropriate. Deleting a line or making a repository private does not revoke a
credential. Coordinate history rewrites and removal of published artifacts with
maintainers; do not silently change existing release bytes or checksums.

Auth-secret rotation also affects retained encrypted coding artifacts. Follow the
operator's recovery procedure and communicate the affected retention window.

## Release checks

The required checks cover type safety, tests, production builds, dependency and
static analysis, and [secret scanning](docs/security-scanning.md). Review security
changes with explicit tests for denied access, cross-account ownership, input
boundaries, and failure/recovery behavior. No automated check establishes that
software is invulnerable; document remaining deployment and provider limits.
