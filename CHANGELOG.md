# Changelog

## 0.4.1 (unreleased)

- Add an encrypted backup that needs no secret on the host: `backup.sh --encrypt` writes the snapshot to stdout as age ciphertext for the operator's public key, so the host can encrypt but never decrypt, and `restore-encrypted.sh` opens it on the operator's machine with his private key and checks the vault. As root the snapshot and the encryption run inside one transient unit with a tmpfs runtime directory that systemd removes (cancelling stops and joins the unit); otherwise the plain snapshot is staged only on tmpfs or ramfs, and the backup refuses when swap could write it to an unencrypted disk. The recipient file is validated once (regular file, owner, no group or world write, only `age1` keys) and the validated keys are passed to age. `restore-encrypted.sh` examines the archive before extracting: only regular `vault.sqlite`, `master.key` and `operator.token`, each once. Tests: `make backup-age-test`, `make backup-age-systemd-test`. The host-held borg backup remains optional and is not enabled by the updater.
- Sign-in and pairing limits are per source address when `OPENPASSWORD_TRUST_PROXY` names the reverse proxy (off by default; forwarded addresses from other peers are ignored; wildcards and over-broad ranges are refused). Behind a proxy without it, all clients share one bucket.
- Add a per-grant ceiling on authenticated `/v1` requests, 600 a minute by default (`OPENPASSWORD_GRANT_RATE`; an empty or malformed value refuses to start, and only an explicit `0` disables it, with a warning). Expired counters are swept so many sources cannot grow memory without bound.

## 0.4.0 (unreleased)

### Scope since 0.2.0

The comparison starts at the published 0.2.0 source commit `6a7a4b6`, integrated into main by `21ffd6f`. It includes the maintainer and council branches in the candidate history. Items that already shipped from main in 0.3.0 and 0.3.1 (bundled Node, verified archives, backups, the `openpassword-` header rename, the loopback console bind) are listed under those versions and not repeated here. The 0.2.0 baseline already provided account linking, organization and personal credential ownership, independent sharing expiry, consumption recording, and remote CLI/MCP integration for coding agents.

### Personal vault, approved hosts and agent grants

- Personal vault items have browser-encrypted names and secret values. Each profile unlocks its own vault with a separately saved recovery key. Hiding the page, navigating away or five minutes of inactivity locks it. Explicit delegation creates a personal provider connection with a gateway-readable copy. Editing the private item leaves copy rotation to its owner.
- First administration, host enrollment and agent approval are separate. A CLI host registers an Ed25519 public key using a one-use web ticket. Its Unix socket service signs CLI and MCP requests. A human approves each agent request for a specific connection, operations and expiry. A different host cannot use the agent's token. Revoking a host blocks subsequent calls from its agents.
- New workspaces on the deployed service require host-bound grants. Workspaces with existing grant history switch on first host enrollment. Re-pair agents at cutover and verify raw bearer-only clients have a signing integration first. The updater refuses a move to a release that predates signature enforcement while active host-bound grants or unredeemed host-bound enrollment tokens exist; revoke them first.

### Model and voice policy

- Added standalone model and voice policy evaluation, descriptor validation, family and alias resolution, wildcard limits, and explicit voice endpoint classification. The vendor registry contains 12 candidate descriptors. The live broker's scoped model discovery and metered chat remain distinct from this policy engine. The candidate descriptors have not been qualified for live routing.

### Deployment and key custody

- Support an independently provisioned wrapping key for new or existing vaults. Wrapped snapshots require the separate credential to decrypt item values.

- Add SSH-backed CLI setup codes for first administration. Codes expire after ten minutes and issuing another supersedes the previous one. The web console can then authorize the agent host. Reject nonprivate or malformed host key files and invalidate pre-setup administrator sessions when the first owner is created.

- Replace the Python updater and production build procedure with verified archive installation. The production host uses a small shell bootstrap, the archive’s own Node v24.19.0 and a TypeScript activation controller. Failed activation restores the old release and its systemd units, including the host-Node to bundled-Node transition. Retain the previous host runtime for rollback.

### Vault interface

- Link provider connections to saved vault items and trace agent grants in both directions. Grant views show operations, model, expiry and revocation. Direct and OAuth credentials retain their existing custody.

- Add matching record marks to vault rows and readers, a workspace-specific engraved directory cover, a clear-search control, and a separate access and activity section alongside desktop credential fields. Group integrations by capability and show operation counts beside each provider.
- Rebuild the vault directory, masked item reader and first-run account screen with the shared family tokens and local fonts. Add persistent System, Light and Dark appearance, bounded server-side item search, stable item and activity URLs, and role-aware copy and reveal controls.
- Apply the palette to connections, integrations, grants, approvals, usage, activity and settings. Collapse mobile navigation and add a searchable workspace switcher.

### Enrollment and agent access

- The first administrator enters the installation setup code in the console. The setup screen directs them to Workspace → CLI hosts to enroll an agent machine.
- Access grants can issue a single-use CLI enrollment token valid for up to ten minutes. The broker stores its digest and exchanges it for scoped device credentials in one SQLite transaction. The console displays the grant ID and CLI connection time. This standalone flow remains available to upgraded standalone workspaces until they switch to host-required access.
- Download the standalone Node.js 24+ CLI from the installation. Use `connect` to enroll with hidden input and `whoami` to verify the active grant. The CLI and MCP expose capabilities, connection and model discovery, metered chat, and scoped activity. Chat accepts an idempotency key. Normal CLI token reads use a read transaction, with serialized writes for refresh.

### Navigation and activity

- Added bookmarkable routes for connections, integrations, grants, approvals, consumption, activity, vault items and workspace settings.
- The browser and CLI can follow activity over HTTP long polling. SQLite stores the ordered events. A process-local notification wakes waiting readers for the relevant workspace or grant. Readers can resume after an event ID. The broker bounds pending waits and checks access again after a wake.

### Service and client updates

- Added staged activation and explicit rollback for the supplied Linux systemd services. The updater preflights the candidate against a disposable vault, serializes switches, records interrupted activation and restores the previous application on failed live readiness.
- A supporting broker drains accepted requests before restart. New requests receive HTTP 503 and a retry hint. Activity watchers reconnect across temporary gateway failures.
- Added a Mac/Linux CLI updater that supports an independently supplied release digest, checks the downloaded bundle against the broker’s SHA-256, runs an offline startup check and replaces the executable atomically. Existing profiles are reused. Running MCP processes pick up the update on restart.

- Activation copies the stopped state directory (manifest, integrity check, owners and modes kept) before the candidate starts and journals it. The candidate is proven on a private broker port against the real store before any public traffic; until then a failure or interruption restores the verified copy (staged, then swapped in) with the old release, and afterwards the journal is committed and a failure is fixed forward. The copy is deleted only after the journal stops naming it.
- The activation controller's readiness probe dials the console at 127.0.0.1, the address its unit binds (0.3.1).

### Verification tools

- Added enrollment, profile isolation, cursor and drain regressions, a reproducible model-gateway load test, and a two-version upgrade rehearsal. The operations guide covers the benchmark, server activation, client update and rollback.

## 0.3.1 · 2026-11-24

- The console binds 127.0.0.1 explicitly (systemd unit, `npm start`, `npm run dev`). With `-H localhost` Node 24 can listen on `::1` only, so a proxy or probe dialing 127.0.0.1 got connection refused. A test keeps the unit, the console rewrites and the broker on the same address.

## 0.3.0 · 2026-11-24

- The release archive bundles the pinned Node.js v24.19.0 (`node/bin/node`, from the official tarball checked against `scripts/node-pins.txt`); the systemd units run it by absolute path, so a host needs no system Node. `RELEASE.json` records the bundled binary and tarball sha256. The build now needs `xz` and network access to nodejs.org. The root package, lockfile root and MCP server version are 0.3.0; the workspace packages under `packages/` keep their own 0.2.0 versions.

- Adds an encrypted off-host backup and a tested restore (`deploy/backup/`, borg with client-side encryption; daily timer unit). `master.key` and the vault travel together only inside the encrypted archive.

Breaking wire changes. Clients and integrations written against the predecessor service's names must update.

- Protocol, capability and on-behalf-of headers use only the `openpassword-` prefix. The legacy headers are no longer sent or accepted.
- Relay headers are `openpassword-upload-link`, `openpassword-relay-seal`, `openpassword-connection`, `openpassword-content-type` and `openpassword-content-range`. The earlier relay headers, which used a different prefix, are no longer accepted.
- Batch manifest and approval-view schema identifiers, and the human-delegation token type, use the `openpassword-` prefix.
- The delegation key document is served at `/.well-known/openpassword-delegation-keys.json`.
- Notebook conversion receipts use the schema `openpassword.notebook-semantics.v1`. Nothing reads the earlier identifier, so earlier receipts are not re-verified.
- Adds `make package COMMIT=<sha>` and `make checksum`. The release is built from that exact commit, requires Node 24.19.0, ships only runtime files and production dependencies, and produces an archive that is reproducible except for the listed per-build secret files (`scripts/per-build-files.txt`), with `RELEASE.json`, a manifest, a completion marker and a `.sha256` sidecar. Build diagnostics are not shipped. The corresponding-source archive now includes the packaging scripts and has normalized metadata.
- The systemd units run from `/opt/openpassword/current`, a symlink to a versioned release directory.
- The reference runner takes the predecessor's identifier prefix from `REFERENCE_ID_PREFIX`.

## 0.2.0 · 2026-11-22

Adds scoped action delegation and refresh-family revocation, retired-key status checks, monetary model leases, tool-call chat, GitHub admission, per-provider dispatch stops, Loops pacing and batch approval views, digest-verified YouTube relay transfer, Notion OAuth, Google batch builders, newsletter and template approval previews, and guarded HubSpot template publication. Adds encrypted Loops and Twilio webhook inboxes, Revolut projections, signed-off publishing journals, TikTok operations, X thread planning and notebook semantic receipts. Adds separate Linux web and broker service identities and a differential fixture runner. Adds scoped operation pauses, legacy Bluesky and Threads publishing, HubSpot issue-bundle uploads, Loops message and audience updates, upload lifecycle and scoped Supabase row mutations. See PARITY.md for remaining replacement gaps.


## 0.1.0 · 2026-11-22

First TypeScript implementation of OpenPassword. The service includes the Next.js operator console, Fastify broker, SQLite custody, human vault items, workspace roles, scoped device pairing, approval queue and actor-attributed audit history. Adds provider-bound operations, selected-resource reads, Gmail artifacts, bounded Loops imports, unsent draft allowances, YouTube resumable uploads and model streaming. Ships the client, CLI, connector library and schemas under MIT.

See PARITY.md for the replacement status and the outstanding differences from the reference.
