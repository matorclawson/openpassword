# Provider and deployment reference

## Provider setup

Google OAuth uses authorization code, PKCE and a single-use session-bound state. Register the console origin followed by `/api/oauth/google/callback` in the Google client. Configure the client ID, secret and scope through the console. Gmail page reads require explicitly authorized label IDs. The Google Sheets connector restricts requests to selected spreadsheet IDs. For a read-only Revolut credential, supply account IDs. Twilio accepts `accountSID:authToken`. Supabase Database takes a JSON credential with `project` and `key`, and an explicit list of table names. The public briefing adapter does not send credentials upstream. GitHub also accepts a JSON credential with app_id, installation_id, private_key and an explicit repository_ids list for read-only installation tokens. Reddit accepts client_id, client_secret and user_agent. Bluesky accepts identifier and app_password. In those modes the broker obtains the short-lived provider token at dispatch. Other token-based integrations take the upstream access token or API key. Provider-specific scopes, account entitlement and test accounts determine which upstream calls succeed.

## Operations

The broker binds to loopback. Next.js also defaults to localhost. Use a TLS reverse proxy for remote access and publish only the intended surfaces. `OPENPASSWORD_HOME` selects the data directory. `OPENPASSWORD_PORT` changes the broker port and the console rewrite destination. Set it consistently at build and start. `OPENPASSWORD_WEB_ORIGIN` must match the browser origin. Enable the optional YouTube chunk relay with `OPENPASSWORD_YOUTUBE_RELAY=1`. Provider keys are entered via the console, without provider environment variables.

Keep the SQLite database and master.key together in a protected backup. For an offline backup stop the service, copy the complete data directory including SQLite sidecars, and preserve file permissions. The default deployment uses a local master key and process-level trust. Use a dedicated service user with a private home. Protect the operator token during initial setup. The local launch and storage layout are designed for Linux including ARM64. The service has been tested on Linux x86-64.

## Packages and verification

- `packages/client` provides the typed device client.
- `packages/cli` implements pairing, token rotation, capability use and revocation.
- `packages/schemas` defines the public request validators.
- `packages/connectors` builds fixed provider requests. It also includes FFmpeg helpers (require system ffmpeg and ffprobe), percent-script notebook conversion and webhook verification.
- `server` owns authentication, dispatch, SQLite and envelopes. `app` owns the browser console. `tests` contains deterministic contract and workflow checks.

Run `make verify`. Provider tests use synthetic data and controlled transports. See [implementation coverage](../PARITY.md) for the distinction between implementation, exercised behavior and migration readiness.

Copyright 2026 Dreamhuggers. The service is AGPL-3.0-only. Each reusable package includes its MIT license. The bundled Space Grotesk font carries its SIL Open Font License in public/fonts.

## Sign in to another application

Under **Workspace → Register app**, enter the application's exact HTTPS callback and audience. Activate its registration. A signed-in workspace member can confirm an identity-only handoff at `/delegate` with a one-use S256 challenge. The application backend exchanges the returned code at `/delegate/exchange` and verifies the Ed25519 signature against its pinned key. The public key document is available at `/.well-known/openpassword-jwks.json`. Identity-only grants expire within ten minutes. Applications can also register action classes. The owner receives a one-time checker credential. The application exchanges a code, rotates the refresh credential and checks each action against POST /v1/delegation/check. A repeated refresh revokes its grant. POST /delegate/status checks identity-only delegations, including those issued by a recently retired key. Owners rotate the signing key with POST /admin/delegation/signing-key/rotate.

## Browser acceptance

After a production build, run `npm run test:browser` with Chromium installed. Set `CHROMIUM_PATH` if the binary is outside /usr/bin/chromium. The check starts an isolated temporary vault and requires the configured broker port to be free. It exercises login, a sealed provider credential, issuance of a scoped grant, mobile search and source download.

## Integration workflows

- Choose **Authorize with Notion** when adding a Notion connection. Register the exact console callback ending in `/api/oauth/notion/callback`. The credential owner can refresh a stored OAuth grant with `POST /admin/connections/{id}/oauth-refresh`.
- Set the allowed template directories on each HubSpot connection. Each directory must end with a slash. Draft upload checks the exact UTF-8 file digests. Publish rereads the draft files, checks their canonical bundle digest and asks for a separate approval.
- On a relay-enabled broker, call `OpenPassword.uploadYouTube(session, blob)` with the authorized connection, upload URL, relay seal, media type, size and SHA-256. The client verifies the file before querying the provider's accepted range through the broker. Keep the session receipt in private storage to resume after a restart.
- `@openpassword/client/publishing` exports `PublishingJournal` and `composePublishingTarget`. Store the SQLite journal in a private application directory. Save a revision, approve its digest, then drive `tick` on a schedule. Its transport takes a scoped broker request. Use an asset resolver that verifies the manifest's digest and returns the selected media reference. After a lost reply or process interruption, recover and resume the original request and idempotency key. The broker remains responsible for provider-side approvals. The publishing test is an executable example.
- An owner can register a Loops or Twilio signing secret using `POST /admin/webhooks` with `connection_id` and a sealed secret from the intake workflow. Configure the returned HTTPS callback with the provider. Read the encrypted delivery inbox via `GET /admin/webhooks/{id}/events?after=0&limit=50`. The cursor is the sequence of the last delivery. Revoke with `DELETE /admin/webhooks/{id}`.
- Use `@openpassword/connectors/local` for local media and notebook operations, `@openpassword/connectors/webhooks` for signature verification, and `@openpassword/connectors/x-thread` for digest-bound X thread planning.

## Linux service identities

The two systemd units in deploy/systemd run the broker and console under separate dynamic users. Place the built tree in /opt/openpassword/releases/<version>, readable by both services, and point the root-owned symlink /opt/openpassword/current at it (switch the symlink to roll back), with no system Node needed: the release bundles Node.js under `node/bin/node`, which the units run by absolute path. Install the units in /etc/systemd/system. The broker owns its private state directory. Set OPENPASSWORD_WEB_ORIGIN in a broker unit override to the externally visible console origin before enabling the services. For an existing instance, migrate the vault and its installation key during an offline maintenance window. Set up and verify HTTPS routing for your domain before connecting remote clients.



### Issue bundles and dispatch controls

Enroll a HubSpot connection with the selected resource `/rasa-newsletter/` and each permitted template directory. Issue the device a grant for `hubspot.files.upload_bundle`. Stage each image at `POST /v1/hubspot/issue-assets` with its original media type and the query fields `connection_id`, `file_name` and `sha256`. Invoke the operation with the returned file manifests, issue ID and bundle digest. The owner can review the upload destination, draft changes and exact manifest before dispatch. Read durable per-step receipts at `GET /v1/hubspot/issues/:id?connection_id=…`. Each issue ID can be reserved once per connection. The public service uses explicit workspace, connection, grant and folder selection in place of the private deployment’s hard-coded organization and portal.

Workspace owners can pause a single operation under **Workspace → Provider dispatch controls**. An upgrade from v0.1 expires outstanding YouTube relay proofs because they lack the operation identity needed for pause enforcement. Request a fresh upload session for an interrupted relay. Revolut transaction reads now require a selected account ID, including the legacy list alias. Supabase table selection permits columns from the selected table and explicitly scoped row writes.

### Personal profiles and sign-in methods

At first launch you can also expand **Create administrator with social sign-in**. Enter the installation setup code and the provider's OAuth web application credentials. Successful authorization creates the owner profile. A password is optional.

Under **Workspace → My profile**, owners, editors and viewers can add or change their username and password, link a configured Google, GitHub or Apple account, and remove individual methods. Each identity belongs to one profile. Linking requires a signed-in session. A workspace member can use their issued access token to enroll. The owner's **Authentication** settings configure the provider applications for the installation. Removing a provider is blocked if a profile depends exclusively on it.

For Apple, configure a Services ID, register the HTTPS domain and the displayed return URL in Apple Developer, and enter a signed Apple client-secret JWT. Rotate the JWT before expiry using the same Services ID. Local installations need a registered HTTPS domain for Apple. Password sign-in works on loopback.

### Credential ownership and sharing

Each workspace is an organization boundary. **Connections** lists the provider accounts you can use, with their source: **Organization**, **Owned by you**, or **Shared by** a named owner. The grant picker uses the same connections. Agent access uses scoped, expiring device tokens; the provider secret stays in the broker.

Only the administrator can add an organization credential. It is available to the entire workspace. Any active member can add a personal credential, which starts private. The owner can use **Edit access** to rename it and share with specific active people or everyone in that workspace. Rotation and revocation belong to the credential owner; the administrator manages organization-owned credentials. Sharing a personal credential with everyone preserves its personal ownership.

Removing someone's access invalidates agent grants they issued for that credential. Restoring sharing requires a new grant. Removing a member invalidates grants issued by that member and grants against that member's personal credentials. Existing installations migrate previously workspace-wide connections to organization ownership. Sign-in methods and human vault items use their existing access rules.

### Credential and sharing expiry

Set **Credential expiry** when connecting a provider or later under **Connections → Edit access**. A blank field gives the connection no OpenPassword deadline. For named sharing, each recipient has a separate deadline. **Whole-organization sharing expiry** limits organization-wide access. The owner retains access until the credential itself expires. All fields accept a UTC date and time and include an **In 7 days** shortcut.

A device grant ends at the earliest of its requested expiry, the credential deadline, and its issuer’s applicable sharing deadline. Shortening a deadline caps existing grants. Extending it permits new grants without extending previously issued ones. These deadlines control use through OpenPassword. A provider can expire or revoke its underlying key independently.

### Consumption

Open **Consumption** to inspect provider requests by credential or agent grant, with a period selector and paginated event history. Usage is attributed to the grant the caller presents. Give each agent a distinct grant when you want separate permissions or usage history. The issuing profile sees its usage; credential owners can also see consumption through their credentials. Organization-owned connections are visible to the administrator.

The SQLite ledger records each outbound HTTP attempt made by a brokered connector operation, model chat completion or YouTube upload relay before dispatch. Each attempt retains the timestamp, credential ID and revision, provider, device grant and label, issuing profile, operation and outcome. Retries that contact a provider count again. Cached replays and broker-only requests add no upstream event. A crashed or incomplete attempt remains visible with an unresolved outcome. A successful HTTP status describes the upstream response; it does not prove a billable operation completed.

Model usage is captured from JSON and streaming usage frames even without a tariff. Optional grant tariffs calculate USD estimates from reported usage. The report joins existing settlement and reconciliation records and shows unsettled reservations separately. Missing usage or pricing remains unpriced. Counts and totals begin with deployment of the ledger. The deployment's existing vault backup includes the ledger. Provider invoices, native Claude Code/Codex sessions and API calls outside the supported broker routes require separate ingestion.

## Release package

On a Linux host with Node 24.19.0 as the build Node (the release refuses any other version), `xz`, and network access to nodejs.org, check out the exact commit to release and run `make package COMMIT=<sha>`, then `make checksum`. `make package` refuses a dirty tree or a different HEAD, builds that commit in a scratch directory from `git archive`, keeps only production dependencies and the runtime files, and writes `dist-release/openpassword-<version>-linux-<arch>.tar.gz`, `RELEASE.json` (commit, tree, Node version and binary hash, lockfile sha256, source epoch) and a completion marker. `make checksum` writes the `.sha256` sidecar only for an archive that matches its marker and `RELEASE.json`. Two builds of the same commit and toolchain are reproducible except for the per-build files listed in `scripts/per-build-files.txt` and in `RELEASE.json` (`per_build_files`): Next.js generates a secret server-reference key on every build, which must differ per build and is never made deterministic. `make package` also writes `<name>.manifest`, the sha256 of every other file, and `scripts/compare-builds.sh <dirA> <dirB>` compares two manifests. Build diagnostics (`.next/trace`, `.next/diagnostics`, `.next/cache`) are not shipped. It includes built output and installed dependencies, so build it on the target architecture. ffmpeg and Chromium are not included.

`make package` refuses to build when `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` is set in the environment, because Next.js embeds a caller-supplied key in the build output; the generated key stays random per build. It also refuses unless every per-build file exists as regular files in the staged release. The only per-build paths are `.next/server/server-reference-manifest.json` (the generated key described below; its `.js` companion showed no variance and is compared) and `.next/server/preview-props.json` and `.next/prerender-manifest.json` (Next's random preview-mode keys, diagnosed in the 4fd28b31 gate diff). `make package` builds in the fixed directory `/tmp/openpassword-release-build` and refuses if it exists, before changing anything, and holds it until the build ends; the directory and `dist-release/` are created owner-only (0700) because they hold per-build key material. It builds there because Next embeds absolute build paths and derives module ids from them, which made two builds in different checkouts differ (also diagnosed in that diff); the first two-build run must confirm they are the only legitimate differences. The server-reference files hold the key Next generated for that build, which the server needs at run time to encrypt Server Action closures. It is random, belongs to no operator, and protects no credential or vault data. Do not substitute your own key at build time. No server action exists in the source today, so that key protects none. `make package` also refuses to build if `app`, `server` or `packages` mention Server Actions or preview/draft mode (`use server`, `draftMode`, `setPreviewData`, `previewData`, `__prerender_bypass`). **The release archive is not a public download.** It also contains Next's random preview-mode values, which the locked Next.js runtime loads at run time; a public archive would disclose the same values to everyone running that build. Do not attach it to a public release. It stays in gate custody and installs are made from there, until a distribution design with per-install keys, or with the framework behaviour disabled, has been qualified. This is the maintainer's reading of Next.js behaviour and is unverified until the gate inspects the built archive.

Deploy the private gate artifact using the archive updater below.

## CLI enrollment and live activity

The installation setup code is read on the server and entered in the browser. Once signed in, create a grant in the target workspace and choose **One-time CLI enrollment token**. The server stores a digest of this ticket. Redeeming it consumes the ticket and issues the device credentials in one SQLite transaction. Existing paired devices can continue to refresh their credentials. If the client loses the response during enrollment, revoke that grant and issue a new ticket.

Use the CLI download served by the installation. Set `OPENPASSWORD_BROKER` and `OPENPASSWORD_AGENT` in the environment of both the CLI and its MCP process. Compare `openpassword whoami` with the ID under **Access grants**. The **CLI connected** timestamp records redemption. An MCP `whoami` call verifies which grant the running harness is using.

The browser long-polls `/api/admin/activity` with its authenticated session. Owners see the selected workspace; members see their own audit actions. The agent endpoint `/v1/activity` returns only events attributed to the authenticated grant. Both return the latest 100 visible events in chronological order on first contact. Pass `after=<last-id>` to read subsequent pages. An idle request waits up to 20 seconds. A timeout returns an empty page and preserves the cursor. To resume a CLI stream, run `openpassword watch LAST_EVENT_ID`.

Keep the reverse proxy's response timeout above 20 seconds. Each broker process caps pending polls at 4,096 total and 512 per audience. A full group returns HTTP 429. SQLite retains the audit events across disconnects and restarts. Wake notifications are local to one broker process. The separate consumption ledger tracks provider requests and usage.

To reproduce the gateway load checks, run `node --import tsx scripts/gateway-load.ts --minute` for 3,000 scheduled chat requests over one minute or omit `--minute` for a 40-client burst. Both use loopback HTTP, a disposable SQLite vault and a simulated upstream. The check verifies dispatches, saved requests, consumption records and the grant's activity cursor.

## Upgrade a running systemd installation

The Linux gate uses Node v24.19.0, runs the test suite, builds the exact commit with `make package COMMIT=<full-sha>`, then runs `make checksum`. Record the approved **archive digest, commit, version and architecture** independently of the file transfer. Keep the archive in gate custody.

On the server use the trusted `deploy/upgrade.sh` delivered separately with the gate handoff. Linux, GNU tar/coreutils, util-linux flock and systemd are required. Production needs neither npm nor a checkout. For example, with the gate's values in the shell:

```sh
sudo sh deploy/upgrade.sh --install "$ARCHIVE" "$EXPECTED_SHA256" "$VERSION" "$EXPECTED_COMMIT"
```

Set the broker unit's environment drop-in to `OPENPASSWORD_WEB_ORIGIN=https://pass.example.com` (use your own public origin). Use the existing reverse proxy. For a nondefault local console port pass `OPENPASSWORD_WEB_PORT` through sudo. The existing vault, master key, sessions and grant records remain in the broker's state directory.

The installer hashes a private staged copy before extraction, then runs the verified release's TypeScript upgrader using its bundled Node. It checks release identity and Node digest, installs the release at `/opt/openpassword/releases/<version>`, and exercises the broker on a disposable vault and the Next launcher under a transient service identity. A previously installed version is reusable only with the same recorded archive digest. Reusing a version from a manual install without a receipt is refused; use a new version.

The activation lock covers preflight through readiness. A supporting broker gets up to 90 seconds to drain. Older brokers use their existing shutdown behavior. The switch captures the installed base units, stops web then broker, atomically replaces `/opt/openpassword/current`, installs the matching units, reloads systemd and restarts. Local console and broker readiness, service working directories and bundled executables must agree. Drop-ins are preserved. On first installation enable both units for boot after successful readiness.

Use the **installed version that contains this updater** as the argument to these maintenance commands, even when the active version is older:

```sh
sudo sh deploy/upgrade.sh --rollback 0.3.0
sudo sh deploy/upgrade.sh --recover 0.3.0
```

Failed activation restores the previous symlink and exact base unit contents. An interrupted transaction is recovered before another switch. Rolling back to 0.2.0 requires the original host Node v24.19.0 on the service PATH. Keep that runtime through the rollback window. Code rollback assumes a backward-compatible database. Keep a protected vault backup for a migration that changes that assumption. Updating the workstation CLI remains a separate `sh deploy/update-client.sh` operation.

On a Mac or Linux client, set `OPENPASSWORD_BROKER` and run `sh deploy/update-client.sh` from this update package. The same script is served at `/update-client.sh` on the updated installation. It downloads the client to a temporary file beside the executable, verifies its SHA-256 against the server, runs an offline startup check, and atomically replaces the executable. CLI profiles stay on the workstation. Restart long-running MCP processes to pick up the new client. A running watch retries temporary gateway failures and continues from its event cursor.

**Trust boundary of the CLI updater.** The updater downloads the CLI over HTTPS (or loopback) and checks it against a SHA-256 served by the same installation. That proves the download is intact, not that the installation is trustworthy: the origin you point it at authorizes the executable you run. If a release needs verification beyond that origin, obtain the digest from an independent source (the release record) and set `OPENPASSWORD_CLI_SHA256` to it when running `deploy/update-client.sh`: the updater then checks the downloaded file against it before it runs the file at all (the updater's own version probe executes the download, so a check done afterwards is too late). Without it, only the same-origin digest is checked.

**An interrupted drain.** While draining, the broker answers new requests with HTTP 503 and a retry hint, and `/health` reports `in_flight` (zero only when no request is open and no model call is unsettled) and `settlement_failed` (calls whose result could not be written durably; they stay counted in `in_flight`, so a drain never treats them as finished, and only a broker restart clears them). Drain state lives only in the running process: if a drain is abandoned or the host restarts partway, restart the broker and the console.
