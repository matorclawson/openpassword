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

// The encrypted outer record protects the random item key along with its title.
export async function sealPrivateItem(
  vault: CryptoKey,
  context: string,
  field: string,
  title: string,
  secret: string,
) {
  const itemKey = newVaultKey()
  const protectedValue = await encryptPrivate(await importVaultKey(itemKey), field, secret)
  return encryptPrivate(vault, context, JSON.stringify({ title, itemKey, protectedValue }))
}
export async function openPrivateValue(
  vault: CryptoKey,
  field: string,
  item: { itemKey?: string; protectedValue: string },
) {
  return decryptPrivate(
    item.itemKey === undefined ? vault : await importVaultKey(item.itemKey),
    field,
    item.protectedValue,
  )
}

export const privateScheme = 'PBKDF2-SHA256-600000-v1'
export async function derivePrivateKey(
  secretKey: string,
  passphrase: string,
  tenant: string,
  profile: string,
) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(secretKey) || !passphrase)
    throw Error('Both vault unlock factors are required')
  const password = await crypto.subtle.importKey('raw', bytes.encode(passphrase), 'PBKDF2', false, [
    'deriveKey',
  ])
  // The generated account secret supplies 256 random bits to the KDF, independent of the password.
  const salt = bytes.encode(
    JSON.stringify(['OpenPassword.vault.unlock', privateScheme, tenant, profile, secretKey]),
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', iterations: 600000, salt },
    password,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}
