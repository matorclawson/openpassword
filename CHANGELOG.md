# Changelog

## 0.3.0 (unreleased)

- Replace the Python updater and production build procedure with verified archive installation. The production host uses a small shell bootstrap, the archive’s own Node v24.19.0 and a TypeScript activation controller. Failed activation restores the old release and its systemd units, including the host-Node to bundled-Node transition. Retain the previous host runtime for rollback.

- The release archive bundles the pinned Node.js v24.19.0 (`node/bin/node`, from the official tarball checked against `scripts/node-pins.txt`); the systemd units run it by absolute path, so a host needs no system Node. `RELEASE.json` records the bundled binary and tarball sha256. The build now needs `xz` and network access to nodejs.org. The root package, lockfile root and MCP server version are 0.3.0; the workspace packages under `packages/` keep their own 0.2.0 versions.

Breaking wire changes. Clients and integrations written against the predecessor service's names must update.

- Protocol, capability and on-behalf-of headers use only the `openpassword-` prefix. The legacy headers are no longer sent or accepted.
- Relay headers are `openpassword-upload-link`, `openpassword-relay-seal`, `openpassword-connection`, `openpassword-content-type` and `openpassword-content-range`. The earlier relay headers, which used a different prefix, are no longer accepted.
- Batch manifest and approval-view schema identifiers, and the human-delegation token type, use the `openpassword-` prefix.
- The delegation key document is served at `/.well-known/openpassword-delegation-keys.json`.
- Notebook conversion receipts use the schema `openpassword.notebook-semantics.v1`. Nothing reads the earlier identifier, so earlier receipts are not re-verified.
- Adds `make package COMMIT=<sha>` and `make checksum`. The release is built from that exact commit, requires Node 24.19.0, ships only runtime files and production dependencies, and produces an archive that is reproducible except for the listed per-build secret files (`scripts/per-build-files.txt`), with `RELEASE.json`, a manifest, a completion marker and a `.sha256` sidecar. Build diagnostics are not shipped. The corresponding-source archive now includes the packaging scripts and has normalized metadata.
- The systemd units run from `/opt/openpassword/current`, a symlink to a versioned release directory.
- The reference runner takes the predecessor's identifier prefix from `REFERENCE_ID_PREFIX`.

### Enrollment and agent access

- The first administrator enters the installation setup code in the console. The setup screen now explains how to issue a separate enrollment token for a client after adding a provider connection.
- Access grants can issue a single-use CLI enrollment token valid for up to ten minutes. The broker stores its digest and exchanges it for scoped device credentials in one SQLite transaction. The console displays the grant ID and CLI connection time. Existing pairing codes, API tokens and device profiles remain supported.
- Download the standalone Node.js 24+ CLI from the installation. Use `connect` to enroll with hidden input and `whoami` to verify the active grant. The CLI and MCP expose capabilities, connection and model discovery, metered chat, and scoped activity. Chat accepts an idempotency key. Normal CLI token reads use a read transaction, with serialized writes for refresh.

### Navigation and activity

- Added bookmarkable routes for connections, integrations, grants, approvals, consumption, activity, vault items and workspace settings.
- The browser and CLI can follow activity over HTTP long polling. SQLite stores the ordered events. A process-local notification wakes waiting readers for the relevant workspace or grant. Readers can resume after an event ID. The broker bounds pending waits and checks access again after a wake.

### Service and client updates

- Added staged activation and explicit rollback for the supplied Linux systemd services. The updater preflights the candidate against a disposable vault, serializes switches, records interrupted activation and restores the previous application on failed live readiness.
- A supporting broker drains accepted requests before restart. New requests receive HTTP 503 and a retry hint. Activity watchers reconnect across temporary gateway failures.
- Added a Mac/Linux CLI updater that checks the downloaded bundle against the broker’s SHA-256, runs an offline startup check and replaces the executable atomically. Existing profiles are reused. Running MCP processes pick up the update on restart.

### Verification tools

- Added enrollment, profile isolation, cursor and drain regressions, a reproducible model-gateway load test, and a two-version upgrade rehearsal. The operations guide covers the benchmark, server activation, client update and rollback.

## 0.2.0 · 2026-11-22

Adds scoped action delegation and refresh-family revocation, retired-key status checks, monetary model leases, tool-call chat, GitHub admission, per-provider dispatch stops, Loops pacing and batch approval views, digest-verified YouTube relay transfer, Notion OAuth, Google batch builders, newsletter and template approval previews, and guarded HubSpot template publication. Adds encrypted Loops and Twilio webhook inboxes, Revolut projections, signed-off publishing journals, TikTok operations, X thread planning and notebook semantic receipts. Adds separate Linux web and broker service identities and a differential fixture runner. Adds scoped operation pauses, legacy Bluesky and Threads publishing, HubSpot issue-bundle uploads, Loops message and audience updates, upload lifecycle and scoped Supabase row mutations. See PARITY.md for remaining replacement gaps.

- The release archive is not a public download: it contains Next.js's random per-build preview-mode and server-reference values. It stays in gate custody and installs are made from there. The build runs in a fixed owner-only directory so that two builds of one commit are identical apart from those listed files.

## 0.1.0 · 2026-11-22

First TypeScript implementation of OpenPassword. The service includes the Next.js operator console, Fastify broker, SQLite custody, human vault items, workspace roles, scoped device pairing, approval queue and actor-attributed audit history. Adds provider-bound operations, selected-resource reads, Gmail artifacts, bounded Loops imports, unsent draft allowances, YouTube resumable uploads and model streaming. Ships the client, CLI, connector library and schemas under MIT.

See PARITY.md for the replacement status and the outstanding differences from the reference.
