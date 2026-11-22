type Ticket = { ticket: string; publicKey: JsonWebKey }
const encode = (v: ArrayBuffer) =>
  btoa(Array.from(new Uint8Array(v), (b) => String.fromCharCode(b)).join(''))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
export async function sealInput(value: string, info: Ticket) {
  const { subtle } = crypto
  const rsa = await subtle.importKey(
    'jwk',
    info.publicKey,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['wrapKey'],
  )
  const aes = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12)),
    encoder = new TextEncoder()
  const ciphertext = await subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(info.ticket) },
    aes,
    encoder.encode(value),
  )
  const wrapped = await subtle.wrapKey('raw', aes, rsa, { name: 'RSA-OAEP' })
  return {
    ticket: info.ticket,
    wrapped: encode(wrapped),
    nonce: encode(iv.buffer),
    ciphertext: encode(ciphertext),
  }
}
