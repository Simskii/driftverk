# Contributing

Open an issue before a substantial feature or architecture change. Keep pull
requests focused and describe the behavior, tests and any migration impact.

Use Node.js 22 or newer, Go matching the module files, and Docker for integration
tests. Install dependencies with `npm ci` in the root, `control-plane`,
`infrastructure/compute-agent` and `infrastructure/data-gateway`.

Run `npm run check`, `npm --prefix control-plane run test:web`,
`npm --prefix control-plane run build`, and `git diff --check`.
For database tests, set `CONTROL_PLANE_TEST_DATABASE_URL` to a disposable local
PostgreSQL database and run `npm --prefix control-plane test`. Tests create
isolated schemas. Never point them at production.

Preserve migration compatibility and the hosted installation's behavior.
Self-hosted changes need tests for both installation modes. A local build does
not prove Sysbox isolation or a successful production deployment.

Do not include credentials, local environment files, customer data or internal
integrations. Use fictional examples and test accounts. Report vulnerabilities
privately as described in SECURITY.md.

Contributions to Driftverk-owned code are submitted under the MIT license.
Only contribute work you have permission to license. Preserve third-party
license and copyright notices; see THIRD_PARTY.md.
