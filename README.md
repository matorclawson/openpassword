# OpenPassword

An open-source workspace for business credentials and agent access. An operator connects a provider account, grants a device specific operations and can revoke it without distributing the provider key. A separate human vault stores shared passwords and notes.

## Run locally

Install Node.js 24 LTS, npm and Make. From this directory:

```sh
make setup
make dev
```

Open **http://localhost:3000**. Read the bootstrap token from the file named by the broker on startup (by default `~/.openpassword/operator.token`). Paste that token into the unlock screen. Team members use their own workspace access tokens. For a production-mode local run, use `make build && make start`. Use the same hostname when signing in and returning from OAuth.

1. Open **Integrations**, choose a provider and inspect its operations. Choose **Connect account** to add a credential. A workspace can hold several named accounts for the same provider.
2. In **Access grants**, select a connection, expiry and the allowed operations. Supply a pairing code for an interactive device, or copy the one-time access and refresh credentials. Access tokens last at most 15 minutes. Refresh rotates both tokens.
3. A device reads its connections and capabilities. Writes enter **Approvals**. Review the account, actor and arguments, approve, then repeat the exact request and idempotency key to receive its outcome. A standing allowance can authorize a bounded number of unsent Loops campaign drafts per UTC day.
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

An owner or editor can grant an OpenAI, OpenRouter or Moonshot account's chat operation with an exact upstream model ID, maximum calls and maximum output tokens per call. Configure an OpenAI-compatible client with the broker's `/v1` base URL and its device bearer. `GET /v1/models` exposes the permitted model. `POST /v1/chat/completions` accepts text messages, explicit `max_tokens`, optional temperature and optional SSE streaming. A repeated supplied `Idempotency-Key` is refused to avoid a second billable submission. A reservation is consumed on an uncertain provider outcome. Live spend and currency settlement are outside this release.

## Provider setup

Google OAuth uses authorization code, PKCE and a single-use session-bound state. Register the console origin followed by `/api/oauth/google/callback` in the Google client. Configure the client ID, secret and scope through the console. Gmail page reads require explicitly authorized label IDs. The Google Sheets connector restricts requests to selected spreadsheet IDs. For a read-only Revolut credential, supply account IDs. Twilio accepts `accountSID:authToken`. Supabase Database takes a JSON credential with `project` and `key`, and an explicit list of table names. The public briefing adapter does not send credentials upstream. GitHub also accepts a JSON credential with app_id, installation_id, private_key and an explicit repository_ids list for read-only installation tokens. Reddit accepts client_id, client_secret and user_agent. Bluesky accepts identifier and app_password. In those modes the broker obtains the short-lived provider token at dispatch. Other token-based integrations take the upstream access token or API key. Provider-specific scopes, account entitlement and test accounts determine which upstream calls succeed.

## Operations

The broker binds to loopback. Next.js also defaults to localhost. Use a TLS reverse proxy for remote access and publish only the intended surfaces. `OPENPASSWORD_HOME` selects the data directory. `OPENPASSWORD_PORT` changes the broker port and the console rewrite destination. Set it consistently at build and start. `OPENPASSWORD_WEB_ORIGIN` must match the browser origin. Enable the optional YouTube chunk relay with `OPENPASSWORD_YOUTUBE_RELAY=1`. Provider keys are entered via the console, without provider environment variables.

Keep the SQLite database and master.key together in a protected backup. For an offline backup stop the service, copy the complete data directory including SQLite sidecars, and preserve file permissions. The default deployment uses a local master key and process-level trust. Use a dedicated service user with a private home. The operator token controls the entire installation. The local launch and storage layout are designed for Linux including ARM64. Qualification evidence in this archive comes from Linux x86-64.

## Packages and verification

- `packages/client` provides the typed device client.
- `packages/cli` implements pairing, token rotation, capability use and revocation.
- `packages/schemas` defines the public request validators.
- `packages/connectors` builds fixed provider requests. It also includes FFmpeg helpers (require system ffmpeg and ffprobe), percent-script notebook conversion and webhook verification.
- `server` owns authentication, dispatch, SQLite and envelopes. `app` owns the browser console. `tests` contains deterministic contract and workflow checks.

Run `make verify`. Provider tests use synthetic data and controlled transports. See PARITY.md for the distinction between implementation, exercised behavior and migration readiness.

Copyright 2026 Dreamhuggers. The service is AGPL-3.0-only. Each reusable package includes its MIT license. The bundled Space Grotesk font carries its SIL Open Font License in public/fonts.
