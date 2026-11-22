# OpenPassword

An open-source workspace for business credentials and agent access. An operator connects a provider account, grants a device specific operations and can revoke it without distributing the provider key. A separate human vault stores shared passwords and notes.

## Run locally

Install Node.js 24 LTS, npm and Make. From this directory:

```sh
make setup
make dev
```

### Create the first administrator

Open the console. Choose a username and a password of at least 12 characters, or expand **Create administrator with social sign-in**. Enter the setup code from the host that runs the broker. The startup message prints the file path. A user-run installation defaults to `~/.openpassword/operator.token`. With the supplied systemd units, read it on the server with `sudo cat /var/lib/openpassword/operator.token`. For a cloud VM, use its SSH or administrative console to read the file. Keep the code private.

| How you reach the console | Address and deployment settings |
| --- | --- |
| On the deployment device | Open `http://localhost:3000`. |
| Private VM through SSH | Run `ssh -N -L 3000:127.0.0.1:3000 user@server` on your computer, then open `http://localhost:3000`. |
| Domain behind a TLS proxy | Set `OPENPASSWORD_WEB_ORIGIN=https://vault.example.com` on the broker, substituting your exact browser origin, and restart it. Route that domain through the proxy to the console on port 3000. The console forwards its API requests to the broker. |

Creating the administrator signs you in and opens **Workspace → Authentication**. You can start using OpenPassword immediately. On subsequent visits use any sign-in method attached to your profile. An existing 0.2.0 installation uses its current operator token for this one-time setup. After setup the token stops working for owner login. Existing workspace members can still choose **Use a workspace access token**. For a production-mode local run, use `make build && make start`.

### Enable Google or GitHub sign-in

In **Workspace → Authentication**, expand the provider and open its developer settings. Create a Google OAuth web application or a GitHub OAuth App and register the exact callback URL displayed by OpenPassword. Paste the **client ID** and **client secret**, save, then choose **Link my account** and authorize with the intended administrator identity. The sign-in page shows that provider after linking. OpenPassword encrypts the client secret and recognizes the linked provider account by its stable ID. You can rotate the application secret while retaining the same client ID and linked profiles. If you change the console domain, update the broker origin and registered callback URLs together.

### Connect your first integration

1. Open **Integrations**, choose a provider and inspect its operations. Choose **Connect account** to add a credential. A workspace can hold several named accounts for the same provider.
2. In **Access grants**, select a connection, expiry and the allowed operations. Supply a pairing code for an interactive device, or copy the one-time access and refresh credentials. Access tokens last at most 15 minutes. Refresh rotates both tokens.
3. A device reads its connections and capabilities. Writes enter **Approvals**. Review the account, actor and arguments, approve, then repeat the exact request and idempotency key to receive its outcome. A standing allowance can authorize a bounded number of unsent Loops campaign drafts or updates to broker-created HubSpot drafts that leave audiences unchanged.
4. Use **Workspace** to issue viewer or editor access, revoke a member, or pause dispatch. **Vault items** allows editors and the owner to reveal shared item values. Provider credentials are never displayed by the vault item routes.

## Agent CLI

After `make setup`:

```sh
node packages/cli/dist/index.js pair editorial
node packages/cli/dist/index.js connections
node packages/cli/dist/index.js invoke CONNECTION_ID github.user.get ticket-001 '{}'
node packages/cli/dist/index.js revoke
```

Use a new task-stable key for a new request. Reuse the original key to obtain an earlier outcome. Devices authenticate to the broker on 127.0.0.1:4141. Set `OPENPASSWORD_BROKER` to an HTTPS broker origin for remote use. CLI identity tokens are stored with mode 0600 under the user's config directory.

## Model clients

An owner or editor can grant an OpenAI, OpenRouter or Moonshot account's chat operation with an exact upstream model ID, maximum calls and maximum output tokens per call. Configure an OpenAI-compatible client with the broker's `/v1` base URL and its device bearer. `GET /v1/models` exposes the permitted model. `POST /v1/chat/completions` accepts text messages, explicit `max_tokens`, optional temperature and optional SSE streaming. A repeated supplied `Idempotency-Key` is refused to avoid a second billable submission. An optional grant tariff reserves integer micro-USD before dispatch. The broker settles from reported usage and retains the reservation when usage is incomplete or the call has an uncertain outcome. The workspace shows the spent, held and available amounts. The owner can list unresolved charges with GET /admin/billing/holds and reconcile one with POST /admin/billing/holds/{execution}, supplying actual_micro_usd and evidence_sha256. Tool-call messages, tool results and function schemas pass through the chat interface.

## Provider setup

Google OAuth uses authorization code, PKCE and a single-use session-bound state. Register the console origin followed by `/api/oauth/google/callback` in the Google client. Configure the client ID, secret and scope through the console. Gmail page reads require explicitly authorized label IDs. The Google Sheets connector restricts requests to selected spreadsheet IDs. For a read-only Revolut credential, supply account IDs. Twilio accepts `accountSID:authToken`. Supabase Database takes a JSON credential with `project` and `key`, and an explicit list of table names. The public briefing adapter does not send credentials upstream. GitHub also accepts a JSON credential with app_id, installation_id, private_key and an explicit repository_ids list for read-only installation tokens. Reddit accepts client_id, client_secret and user_agent. Bluesky accepts identifier and app_password. In those modes the broker obtains the short-lived provider token at dispatch. Other token-based integrations take the upstream access token or API key. Provider-specific scopes, account entitlement and test accounts determine which upstream calls succeed.

## Operations

The broker binds to loopback. Next.js also defaults to localhost. Use a TLS reverse proxy for remote access and publish only the intended surfaces. `OPENPASSWORD_HOME` selects the data directory. `OPENPASSWORD_PORT` changes the broker port and the console rewrite destination. Set it consistently at build and start. `OPENPASSWORD_WEB_ORIGIN` must match the browser origin. Enable the optional YouTube chunk relay with `OPENPASSWORD_YOUTUBE_RELAY=1`. Provider keys are entered via the console, without provider environment variables.

Keep the SQLite database and master.key together in a protected backup. For an offline backup stop the service, copy the complete data directory including SQLite sidecars, and preserve file permissions. The default deployment uses a local master key and process-level trust. Use a dedicated service user with a private home. Protect the operator token during initial setup. The local launch and storage layout are designed for Linux including ARM64. Qualification evidence in this archive comes from Linux x86-64.

## Packages and verification

- `packages/client` provides the typed device client.
- `packages/cli` implements pairing, token rotation, capability use and revocation.
- `packages/schemas` defines the public request validators.
- `packages/connectors` builds fixed provider requests. It also includes FFmpeg helpers (require system ffmpeg and ffprobe), percent-script notebook conversion and webhook verification.
- `server` owns authentication, dispatch, SQLite and envelopes. `app` owns the browser console. `tests` contains deterministic contract and workflow checks.

Run `make verify`. Provider tests use synthetic data and controlled transports. See PARITY.md for the distinction between implementation, exercised behavior and migration readiness.

Copyright 2026 Dreamhuggers. The service is AGPL-3.0-only. Each reusable package includes its MIT license. The bundled Space Grotesk font carries its SIL Open Font License in public/fonts.

## Sign in to another application

Under **Workspace → Register app**, enter the application's exact HTTPS callback and audience. Activate its registration. A signed-in workspace member can confirm an identity-only handoff at `/delegate` with a one-use S256 challenge. The application backend exchanges the returned code at `/delegate/exchange` and verifies the Ed25519 signature against its pinned key. The public key document is available at `/.well-known/zeoconnect-delegation-keys.json`. Identity-only grants expire within ten minutes. Applications can also register action classes. The owner receives a one-time checker credential. The application exchanges a code, rotates the refresh credential and checks each action against POST /v1/delegation/check. A repeated refresh revokes its grant. POST /delegate/status checks identity-only delegations, including those issued by a recently retired key. Owners rotate the signing key with POST /admin/delegation/signing-key/rotate.

## Browser acceptance

After a production build, run `npm run test:browser` with Chromium installed. Set `CHROMIUM_PATH` if the binary is outside /usr/bin/chromium. The check starts an isolated temporary vault and requires the configured broker port to be free. It exercises login, a sealed provider credential, issuance of a scoped grant, mobile search and source download.

## Integration workflows

- Choose **Authorize with Notion** when adding a Notion connection. Register the exact console callback ending in `/api/oauth/notion/callback`. An editor can refresh a stored OAuth grant with `POST /admin/connections/{id}/oauth-refresh`.
- Set the allowed template directories on each HubSpot connection. Each directory must end with a slash. Draft upload checks the exact UTF-8 file digests. Publish rereads the draft files, checks their canonical bundle digest and asks for a separate approval.
- On a relay-enabled broker, call `OpenPassword.uploadYouTube(session, blob)` with the authorized connection, upload URL, relay seal, media type, size and SHA-256. The client verifies the file before querying the provider's accepted range through the broker. Keep the session receipt in private storage to resume after a restart.
- `@openpassword/client/publishing` exports `PublishingJournal` and `composePublishingTarget`. Store the SQLite journal in a private application directory. Save a revision, approve its digest, then drive `tick` on a schedule. Its transport takes a scoped broker request. Use an asset resolver that verifies the manifest's digest and returns the selected media reference. After a lost reply or process interruption, recover and resume the original request and idempotency key. The broker remains responsible for provider-side approvals. The publishing test is an executable example.
- An owner can register a Loops or Twilio signing secret using `POST /admin/webhooks` with `connection_id` and a sealed secret from the intake workflow. Configure the returned HTTPS callback with the provider. Read the encrypted delivery inbox via `GET /admin/webhooks/{id}/events?after=0&limit=50`. The cursor is the sequence of the last delivery. Revoke with `DELETE /admin/webhooks/{id}`.
- Use `@openpassword/connectors/local` for local media and notebook operations, `@openpassword/connectors/webhooks` for signature verification, and `@openpassword/connectors/x-thread` for digest-bound X thread planning.

## Linux service identities

The two systemd units in deploy/systemd run the broker and console under separate dynamic users. Build the checkout in /opt/openpassword, readable by both services, with Node 24 on the system service PATH. Install the units in /etc/systemd/system. The broker owns its private state directory. Set OPENPASSWORD_WEB_ORIGIN in a broker unit override to the externally visible console origin before enabling the services. For an existing instance, migrate the vault and its installation key during an offline maintenance window. The units were syntax checked in the council environment. Host installation, TLS routing and upgrades require deployment qualification.

Run `npm run test:reference -- /path/to/zeoconnect-source` to compare the upstream fixtures with the public TypeScript validators and preview producer.

### Issue bundles and dispatch controls

Enroll a HubSpot connection with the selected resource `/rasa-newsletter/` and each permitted template directory. Issue the device a grant for `hubspot.files.upload_bundle`. Stage each image at `POST /v1/hubspot/issue-assets` with its original media type and the query fields `connection_id`, `file_name` and `sha256`. Invoke the operation with the returned file manifests, issue ID and bundle digest. The owner can review the upload destination, draft changes and exact manifest before dispatch. Read durable per-step receipts at `GET /v1/hubspot/issues/:id?connection_id=…`. Each issue ID can be reserved once per connection. The public service uses explicit workspace, connection, grant and folder selection in place of the private deployment’s hard-coded organization and portal.

Workspace owners can pause a single operation under **Workspace → Provider dispatch controls**. An upgrade from v0.1 expires outstanding YouTube relay proofs because they lack the operation identity needed for pause enforcement. Request a fresh upload session for an interrupted relay. Revolut transaction reads now require a selected account ID, including the legacy list alias. Supabase table selection permits columns from the selected table and explicitly scoped row writes.

### Personal profiles and sign-in methods

At first launch you can also expand **Create administrator with social sign-in**. Enter the installation setup code and the provider's OAuth web application credentials. Successful authorization creates the owner profile. A password is optional.

Under **Workspace → My profile**, owners, editors and viewers can add or change their username and password, link a configured Google, GitHub or Apple account, and remove individual methods. Each identity belongs to one profile. Linking requires a signed-in session. A workspace member can use their issued access token to enroll. The owner's **Authentication** settings configure the provider applications for the installation. Removing a provider is blocked if a profile depends exclusively on it.

For Apple, configure a Services ID, register the HTTPS domain and the displayed return URL in Apple Developer, and enter a signed Apple client-secret JWT. Rotate the JWT before expiry using the same Services ID. Local installations need a registered HTTPS domain for Apple. Password sign-in works on loopback.
