import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, verify } from 'node:crypto'
import { scopedToken } from '../server/provider-auth.ts'
test('installation tokens bind a signed assertion to a read-only repository selection', async () => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const config = {
    app_id: '12',
    installation_id: '34',
    private_key: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    repository_ids: [7],
  }
  const value = await scopedToken('github_read', JSON.stringify(config), async (url, init) => {
    assert.equal(String(url), 'https://api.github.com/app/installations/34/access_tokens')
    const jwt = new Headers(init?.headers).get('Authorization')!.slice(7).split('.')
    assert.equal(
      verify(
        'RSA-SHA256',
        Buffer.from(jwt.slice(0, 2).join('.')),
        keys.publicKey,
        Buffer.from(jwt[2], 'base64url'),
      ),
      true,
    )
    const b = JSON.parse(String(init?.body))
    assert.deepEqual(b.repository_ids, [7])
    assert.ok(Object.values(b.permissions).every((v) => v === 'read'))
    return Response.json({ token: 'ephemeral-example' })
  })
  assert.equal(value, 'ephemeral-example')
})
