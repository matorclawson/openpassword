import { encryptPrivate, decryptPrivate, importVaultKey, newVaultKey } from './private-crypto'

const rsa = { name: 'RSA-OAEP', hash: 'SHA-256' }
const encode = (data: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(data)))
const decode = (data: string) => Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
export const identityContext = (tenant: string, profile: string) =>
  JSON.stringify(['OpenPassword.read-identity.v1', tenant, profile])
export async function sharingIdentity(key: CryptoKey, context: string) {
  const pair = await crypto.subtle.generateKey(
    { ...rsa, modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ['encrypt', 'decrypt'],
  )
  const pub = encode(await crypto.subtle.exportKey('spki', pair.publicKey))
  const sealed = await encryptPrivate(
    key,
    context,
    encode(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
  )
  return { pub, sealed }
}
export async function fingerprint(pub: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', decode(pub))), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')
}
export type Binding = {
  tenant: string
  owner: string
  recipient: string
  item: string
  revision: number
  id: string
  expires: number
}
const context = (b: Binding) =>
  JSON.stringify([
    'OpenPassword.read-copy.v1',
    b.tenant,
    b.owner,
    b.recipient,
    b.item,
    b.revision,
    b.id,
    b.expires,
  ])
export async function sealCopy(
  pub: string,
  expected: string,
  b: Binding,
  title: string,
  secret: string,
) {
  if ((await fingerprint(pub)) !== expected) throw Error('Recipient fingerprint does not match.')
  const key = newVaultKey()
  const recipient = await crypto.subtle.importKey('spki', decode(pub), rsa, false, ['encrypt'])
  const label = new TextEncoder().encode(context(b))
  const wrapped = encode(
    await crypto.subtle.encrypt(
      { name: 'RSA-OAEP', label },
      recipient,
      new TextEncoder().encode(key),
    ),
  )
  return {
    wrapped,
    value: await encryptPrivate(
      await importVaultKey(key),
      context(b),
      JSON.stringify({ title, secret }),
    ),
  }
}
export async function openCopy(
  key: CryptoKey,
  sealed: string,
  b: Binding,
  wrapped: string,
  value: string,
) {
  const raw = await decryptPrivate(key, identityContext(b.tenant, b.recipient), sealed)
  const priv = await crypto.subtle.importKey('pkcs8', decode(raw), rsa, false, ['decrypt'])
  const label = new TextEncoder().encode(context(b))
  const material = await crypto.subtle.decrypt({ name: 'RSA-OAEP', label }, priv, decode(wrapped))
  return JSON.parse(
    await decryptPrivate(
      await importVaultKey(new TextDecoder().decode(material)),
      context(b),
      value,
    ),
  ) as { title: string; secret: string }
}

export async function sealRecoveryCode(
  pub: string,
  expected: string,
  context: string,
  code: string,
) {
  if ((await fingerprint(pub)) !== expected) throw Error('Recipient fingerprint mismatch')
  const key = await crypto.subtle.importKey('spki', decode(pub), rsa, false, ['encrypt'])
  return encode(
    await crypto.subtle.encrypt(
      { name: 'RSA-OAEP', label: new TextEncoder().encode(context) },
      key,
      new TextEncoder().encode(code),
    ),
  )
}
export async function openRecoveryCode(
  vault: CryptoKey,
  sealed: string,
  identity: string,
  context: string,
  box: string,
) {
  const pkcs8 = await decryptPrivate(vault, identity, sealed)
  const key = await crypto.subtle.importKey('pkcs8', decode(pkcs8), rsa, false, ['decrypt'])
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      { name: 'RSA-OAEP', label: new TextEncoder().encode(context) },
      key,
      decode(box),
    ),
  )
}
