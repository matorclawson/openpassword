# Use OpenPassword over HTTP

Use the same public HTTPS origin as the web console. All agent routes start with `/v1/`. The REST client sends requests directly to the broker. Each service gets its own grant. Owners manage connections, private vault items and approvals through their authenticated web session.

## Try the API

1. Set `OPENPASSWORD_BROKER` to the deployed origin, for example `https://vault.example.com`. Fetch the public OpenAPI 3.1 document with `curl -fsS "$OPENPASSWORD_BROKER/v1/openapi.json"`. Import it into your API tooling to browse the core agent endpoints.
2. On an [enrolled host](operations.md#enroll-an-agent-host-and-approve-its-agents), set `OPENPASSWORD_HOST_SOCKET` to its signing bridge socket. From the source directory run `node examples/http/agent.ts github` with Node 24. The example uses built-in fetch and the local socket. It requires no installed npm packages.
3. In **Access grants**, approve the displayed request for a GitHub connection and the `github.user.get` operation. The script reads the connected GitHub login and revokes its demo grant. To keep a service connected, retain its token pair privately and rotate it before expiry.

For a model call, run `node examples/http/agent.ts chat` and approve a model grant with a remaining call. It requests one short completion under that grant and revokes the demo grant afterward.

| Request | Use |
| --- | --- |
| POST /v1/device/authorizations | Send `{"device_name":"My service"}`. Display the pairing ID to the operator. Keep the returned device code private. |
| POST /v1/device/token | Send `{"device_code":"…"}`. Poll at the returned interval. HTTP 428 means approval is still pending. Stop at expiry and back off on 429. |
| GET /v1/whoami, /v1/session | Read the agent identity, connection and expiry. |
| GET /v1/connections, /v1/capabilities | Discover the authorized connection, provider operations and model lease. |
| POST /v1/operations/{operation_id}:invoke | Send the operation ID, connection ID, arguments, expected binding and an idempotency key. |
| GET /v1/models, POST /v1/chat/completions | Discover and use the granted model. Supply model, messages and a positive max_tokens. Set stream to true for server-sent events. |
| GET /v1/activity?after=42&wait=20000 | Read the grant's activity after a cursor. Wait is in milliseconds. Use the returned cursor for the next request. |
| POST /v1/device/token/refresh | Send the refresh token in the JSON body. Serialize refreshes and atomically replace both tokens. |
| POST /v1/device/revoke | Revoke this agent grant. Success returns HTTP 204. |

## Authenticate an HTTP request

Send `OpenPassword-Protocol-Version: 1` and, after exchange, `Authorization: Bearer <agent access token>`. Set `Content-Type: application/json` on JSON bodies. The model endpoints also accept requests without the protocol header. A host-bound grant requires a fresh `OpenPassword-Host` proof on each request, including pairing, redemption and refresh. The HTTP client can live on any approved machine that can reach the broker. Only the host signing service needs its private key.

The example obtains the proof directly from the signing socket. A Node service using the built package can import `hostProof` from `@openpassword/client/host-proof`. Set the signing socket explicitly when using that helper. For other languages, the socket accepts HTTP GET on `/<fingerprint>` and returns the text for the proof header. The fingerprint is the lowercase hexadecimal SHA-256 of the UTF-8 JavaScript JSON serialization of the array below.

```text
[publicOrigin, uppercaseMethod, exactPathWithQuery, sha256(authorizationHeader), sha256(body)]
```

Use the broker's configured public origin without a trailing slash. For JSON, the broker hashes its parsed body serialized with JavaScript JSON.stringify. Match that representation, including escaping, numeric formatting and property order. A bodyless request or absent authorization uses the hash of the empty string. Binary routes use the body bytes. Sign again after changing any input or retrying. Standalone grants in workspaces that explicitly allow them use the same HTTP routes with the bearer token alone.

For example, this calls the deployed API with curl on an approved host. Supply the short-lived agent token as OPENPASSWORD_ACCESS_TOKEN through the calling service’s secret store. From the repository root, use Node 24 to request a proof and pass the headers to curl on stdin.

```sh
(
  set -e
  node --input-type=module <<'JS'
import { hostProof } from './packages/client/host-proof.ts'
const { OPENPASSWORD_BROKER, OPENPASSWORD_HOST_SOCKET, OPENPASSWORD_ACCESS_TOKEN } = process.env
if (!OPENPASSWORD_HOST_SOCKET || !OPENPASSWORD_ACCESS_TOKEN) throw Error('Missing signing socket or agent token')
const auth = 'Bearer ' + OPENPASSWORD_ACCESS_TOKEN
const proof = await hostProof(new URL(OPENPASSWORD_BROKER).origin, 'GET', '/v1/whoami', auth, '')
console.log('OpenPassword-Protocol-Version: 1')
console.log('Authorization: ' + auth)
console.log('OpenPassword-Host: ' + proof['OpenPassword-Host'])
JS
) | curl --fail --silent --show-error --proto '=https' --header @- "$OPENPASSWORD_BROKER/v1/whoami"
```

## Invoke an operation

First fetch capabilities. Copy the returned connection ID, external identity and revision. Send `OpenPassword-Capabilities: expected-binding` and a JSON body like this to `POST /v1/operations/github.user.get:invoke`.

```json
{
  "connection_id": "connection-from-capabilities",
  "operation_id": "github.user.get",
  "arguments": {},
  "expect": {"external_identity": "login-from-capabilities", "connection_revision": "1"},
  "idempotency_key": "a-unique-key-for-this-lookup"
}
```

Reuse the key only for a retry of the same logical operation. Inspect the result status and receipt. Some operations need human approval before dispatch. HTTP 401 indicates an invalid or expired credential. HTTP 403 means the host or grant cannot authorize the request. HTTP 426 identifies an incompatible protocol header. The OpenAPI document describes the core agent workflow. Provider-specific uploads, administrative sessions and private vault operations have separate contracts.
