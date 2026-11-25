import { request } from 'node:http'
import { createHash } from 'node:crypto'

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')

export async function hostProof(
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
