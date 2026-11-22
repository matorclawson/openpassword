import { generateKeyPairSync, privateDecrypt, createDecipheriv, constants } from 'node:crypto'
import { z } from 'zod'
const encoded = z.string().regex(/^[A-Za-z0-9_-]+$/)
export const envelope = z
  .object({
    ticket: encoded.max(80),
    wrapped: encoded.max(600),
    nonce: encoded.length(16),
    ciphertext: encoded.max(60000),
  })
  .strict()
export function intakeKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return {
    publicKey: publicKey.export({ format: 'jwk' }),
    unseal(b: z.infer<typeof envelope>) {
      const dek = privateDecrypt(
        { key: privateKey, oaepHash: 'sha256', padding: constants.RSA_PKCS1_OAEP_PADDING },
        Buffer.from(b.wrapped, 'base64url'),
      )
      const bytes = Buffer.from(b.ciphertext, 'base64url'),
        d = createDecipheriv('aes-256-gcm', dek, Buffer.from(b.nonce, 'base64url'))
      d.setAAD(Buffer.from(b.ticket))
      d.setAuthTag(bytes.subarray(-16))
      return Buffer.concat([d.update(bytes.subarray(0, -16)), d.final()]).toString('utf8')
    },
  }
}
