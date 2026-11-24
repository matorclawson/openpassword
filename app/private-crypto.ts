const bytes = new TextEncoder()
const encode = (data: Uint8Array) =>
  btoa(Array.from(data, (x) => String.fromCharCode(x)).join(''))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
const decode = (value: string) =>
  Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0))
export const newVaultKey = () => encode(crypto.getRandomValues(new Uint8Array(32)))
export async function importVaultKey(value: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw Error('Enter your 43-character private vault key')
  return crypto.subtle.importKey('raw', decode(value), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ])
}
export async function encryptPrivate(key: CryptoKey, context: string, value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: bytes.encode(context) },
    key,
    bytes.encode(value),
  )
  const result = new Uint8Array(12 + encrypted.byteLength)
  result.set(iv)
  result.set(new Uint8Array(encrypted), 12)
  return encode(result)
}
export async function decryptPrivate(key: CryptoKey, context: string, value: string) {
  const data = decode(value)
  const clear = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: data.subarray(0, 12), additionalData: bytes.encode(context) },
    key,
    data.subarray(12),
  )
  return new TextDecoder().decode(clear)
}
