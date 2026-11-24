import { createServer, request } from 'node:http'
import {
  randomBytes,
  createHash,
  generateKeyPairSync,
  sign,
  createPrivateKey,
  createPublicKey,
} from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, chmodSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { OpenPassword } from '@openpassword/client'

const hash = (x: string | Uint8Array) => createHash('sha256').update(x).digest('hex')
type Identity = { origin: string; id: string; key: string }
const home = process.env.OPENPASSWORD_HOST_HOME || join(homedir(), '.config/openpassword/hosts')
const file = (origin: string) => join(home, hash(origin) + '.json')
export async function enroll(origin: string, ticket: string) {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  if (!/^[a-f0-9-]{36}\.[\w-]{43}$/.test(ticket))
    throw Error('Enter a host enrollment token from Workspace → CLI hosts')
  const id = ticket.slice(0, 36),
    path = file(origin)
  // Persist the complete identity before redemption, including for a lost HTTP response.
  const { privateKey } = generateKeyPairSync('ed25519')
  try {
    writeFileSync(
      path,
      JSON.stringify({
        id,
        origin,
        key: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      }),
      { mode: 0o600, flag: 'wx', flush: true },
    )
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
  }
  const identity = readIdentity(origin)
  if (identity.id !== id)
    throw Error(
      'A different host identity already exists. Revoke the old host before replacing its identity file.',
    )
  const pub = createPublicKey(identity.key).export({ format: 'jwk' }).x
  const result = await new OpenPassword(origin).request<{ id: string }>('/v1/hosts/enroll', {
    ticket,
    key: pub,
  })
  if (result.id !== id) throw Error('Broker returned an unexpected host ID')
  console.log('Host enrolled:', id)
}
function readIdentity(origin: string) {
  const path = file(origin)
  if ((statSync(path).mode & 0o077) !== 0) throw Error('Host identity file must be private')
  const identity = JSON.parse(readFileSync(path, 'utf8')) as Identity
  if (identity.origin !== origin || !identity.id) throw Error('Host enrollment incomplete')
  return identity
}
export function serveHost(origin: string, socket: string) {
  const identity = readIdentity(origin)
  const key = createPrivateKey(identity.key)
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || !/^\/[a-f0-9]{64}$/.test(req.url || '')) {
      res.writeHead(400).end()
      return
    }
    const time = String(Date.now()),
      nonce = randomBytes(16).toString('base64url')
    const message = ['OpenPassword.host.1', identity.id, time, nonce, req.url!.slice(1)].join('.')
    const sig = sign(null, Buffer.from(message), key).toString('base64url')
    res.end([identity.id, time, nonce, sig].join('.'))
  })
  server.on('error', () => {
    console.error('Host bridge could not listen. Check the socket directory and existing bridge.')
    process.exitCode = 1
  })
  server.listen(socket, () => {
    chmodSync(socket, 0o660)
    console.error('Host bridge ready:', socket)
  })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close())
}
export async function proof(
  origin: string,
  method: string,
  path: string,
  authorization: string,
  body: string | Uint8Array,
): Promise<Record<string, string>> {
  const socketPath = process.env.OPENPASSWORD_HOST_SOCKET
  if (!socketPath) return {}
  const fingerprint = hash(JSON.stringify([origin, method, path, hash(authorization), hash(body)]))
  const value = await new Promise<string>((resolve, reject) => {
    const req = request({ socketPath, path: '/' + fingerprint, timeout: 3000 }, (res) => {
      let result = ''
      res.on('data', (chunk) => {
        result += chunk
        if (result.length > 300) res.destroy(Error('Invalid bridge response'))
      })
      res.on('error', reject)
      res.on('end', () =>
        res.statusCode === 200 ? resolve(result) : reject(Error('Host bridge refused request')),
      )
    })
    req
      .on('error', reject)
      .on('timeout', () => req.destroy(Error('Host bridge timed out')))
      .end()
  })
  return { 'OpenPassword-Host': value }
}
