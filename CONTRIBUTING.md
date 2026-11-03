# Contributing

Use Node 24 and a disposable local PostgreSQL database. Follow the
[local setup](README.md#local-start) and [testing guide](docs/testing.md).
Choose `WICK_MODE=fixture` and `MUSE_MODE=fixture` for ordinary development.
Real-provider scripts can spend money and create infrastructure; run them only
with explicit operator authorization and their documented cleanup safeguards.

Keep changes focused. Preserve account ownership checks, immutable accepted
prices, idempotency, transaction boundaries, and uncertain-outcome recovery.
For security changes, add a regression that demonstrates the denied operation or
failure path; avoid tests that only repeat the implementation. Include the
problem, resulting behavior, verification performed, and remaining limits in
the PR description.

Before opening a PR, run:

```sh
npm run typecheck
npm test
npm run build
npm run security:secrets
```

Run the browser, database, recovery, and other security checks required by the
affected feature and CI. Database and browser checks require their explicit
local setup; a skipped test is not passing evidence. Never point fixture tests
at a production database. The secret scanner requires Git, Python 3, tar, and
network access to download its checksum-pinned Gitleaks binary.

Do not commit credentials, local environment files, database exports, private
resource journals, recordings, or generated test output. Review `git diff
--cached` and package contents before publishing. An ignore rule does not remove
an already-tracked file. Read the [security policy](SECURITY.md) before reporting
a vulnerability.

Source changes and newly built packages use the [MIT license](LICENSE).
Keep `client-releases/` historical artifacts and manifests byte-for-byte intact;
license metadata in those historical packages records their original release.
New client releases need a new version, reproducible package contents, updated
checksums/manifests, and a complete artifact scan. Confirm that any third-party
material you add can be redistributed and retain its required attribution.
