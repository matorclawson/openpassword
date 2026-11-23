# Changelog

## Unreleased · 2026-11-23

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

## 0.1.0 · 2026-11-22

First TypeScript implementation of OpenPassword. The service includes the Next.js operator console, Fastify broker, SQLite custody, human vault items, workspace roles, scoped device pairing, approval queue and actor-attributed audit history. Adds provider-bound operations, selected-resource reads, Gmail artifacts, bounded Loops imports, unsent draft allowances, YouTube resumable uploads and model streaming. Ships the client, CLI, connector library and schemas under MIT.

See PARITY.md for the replacement status and the outstanding differences from the reference.
