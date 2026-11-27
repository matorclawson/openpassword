// Node 24. Run directly from the source tree. No package installation is required.
import { hostProof } from '../../packages/client/host-proof.ts'
import { setTimeout as delay } from 'node:timers/promises'

const endpoint = new URL(process.env.OPENPASSWORD_BROKER || '')
if (
  endpoint.href !== endpoint.origin + '/' ||
  !(
    endpoint.protocol === 'https:' ||
    (endpoint.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))
  )
) {
  throw Error('Set OPENPASSWORD_BROKER to an HTTPS origin or loopback HTTP origin')
}
if (!process.env.OPENPASSWORD_HOST_SOCKET?.startsWith('/'))
  throw Error('Set the enrolled host signing socket')
async function request(path: string, payload?: object, token?: string) {
  const body = payload === undefined ? undefined : JSON.stringify(payload)
  const method = body === undefined ? 'GET' : 'POST'
  const authorization = token ? 'Bearer ' + token : ''
  const proof = await hostProof(endpoint.origin, method, path, authorization, body || '')
  return fetch(endpoint.origin + path, {
    method,
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(90000),
    headers: {
      ...proof,
      ...(token ? { authorization } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
      'OpenPassword-Protocol-Version': '1',
      'OpenPassword-Capabilities': 'expected-binding',
    },
  })
}
async function checked(response: Response) {
  if (!response.ok) throw Error('Broker returned HTTP ' + response.status)
  return response
}
async function run() {
  const command = process.argv[2]
  if (!['github', 'chat'].includes(command))
    throw Error('Usage: node examples/http/agent.ts github | chat')
  const pair = await (
    await checked(await request('/v1/device/authorizations', { device_name: 'HTTP example' }))
  ).json()
  console.log('Approve request', pair.pairing_id, 'under Access grants at', endpoint.origin)
  while (Date.now() < Date.parse(pair.expires_at)) {
    await delay(pair.interval_seconds * 1000)
    const response = await request('/v1/device/token', { device_code: pair.device_code })
    if (response.status === 428 || response.status === 429) continue
    const { access_token } = await (await checked(response)).json()
    try {
      const capabilities = await (
        await checked(await request('/v1/capabilities', undefined, access_token))
      ).json()
      if (command === 'chat') {
        const lease = capabilities.model_lease
        if (!lease?.remaining) throw Error('This grant has no remaining model calls')
        const result = await (
          await checked(
            await request(
              '/v1/chat/completions',
              {
                model: lease.model,
                max_tokens: Math.min(32, lease.max_tokens),
                messages: [{ role: 'user', content: 'Say hello in one sentence.' }],
              },
              access_token,
            ),
          )
        ).json()
        console.log(result.choices[0].message.content)
        return
      }
      if (!capabilities.operations.some((op: { id: string }) => op.id === 'github.user.get'))
        throw Error('Grant lacks github.user.get')
      const result = await (
        await checked(
          await request(
            '/v1/operations/github.user.get:invoke',
            {
              connection_id: capabilities.connection_id,
              operation_id: 'github.user.get',
              arguments: {},
              idempotency_key: crypto.randomUUID(),
              expect: {
                external_identity: capabilities.external_identity,
                connection_revision: capabilities.connection_revision,
              },
            },
            access_token,
          ),
        )
      ).json()
      if (result.status !== 'confirmed') throw Error('GitHub lookup status: ' + result.status)
      console.log(result.result.login)
    } finally {
      await checked(await request('/v1/device/revoke', {}, access_token))
    }
    return
  }
  throw Error('Pairing expired')
}
await run()
