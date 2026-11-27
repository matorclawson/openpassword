import { encryptPrivate, decryptPrivate, importVaultKey } from './private-crypto'
export type VaultScope = { tenant: string; profile: string; check: string }
export const custodyContext = (p: VaultScope, purpose: string) =>
  JSON.stringify([
    'OpenPassword.custody.v1',
    location.origin,
    p.tenant,
    p.profile,
    p.check,
    purpose,
  ])
export const wrapVaultKey = encryptPrivate
export async function unwrapVaultKey(wrapping: CryptoKey, context: string, box: string) {
  return importVaultKey(await decryptPrivate(wrapping, context, box))
}
const decode = (str: string) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0))
const encode = (v: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(v)))
type PrfResult = { prf?: { results?: { first?: ArrayBuffer } } }
async function deviceKey(id: string, salt: string) {
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ type: 'public-key', id: decode(id) }],
      userVerification: 'required',
      extensions: {
        prf: { eval: { first: decode(salt) } },
      } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null
  if (!assertion || encode(assertion.rawId) !== id) throw Error('Device unavailable')
  const flags = new Uint8Array(
    (assertion.response as AuthenticatorAssertionResponse).authenticatorData,
  )[32]
  const material = (assertion.getClientExtensionResults() as PrfResult).prf?.results?.first
  if ((flags & 5) !== 5 || (flags & 8) !== 0 || material?.byteLength !== 32)
    throw Error('Use a device-bound authenticator with user verification and PRF support.')
  return crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ])
}
export async function enrollDevice(
  p: VaultScope,
  material: string,
  register: () => Promise<{ id: string; expires: number }>,
) {
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: 'OpenPassword' },
      user: {
        id: crypto.getRandomValues(new Uint8Array(32)),
        name: p.profile,
        displayName: 'Private vault unlock',
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: { userVerification: 'required', residentKey: 'discouraged' },
      extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null
  if (!cred) throw Error('Device enrollment cancelled')
  const id = encode(cred.rawId),
    salt = encode(crypto.getRandomValues(new Uint8Array(32)).buffer)
  const key = await deviceKey(id, salt),
    { id: enrollment, expires } = await register(),
    value = await wrapVaultKey(
      key,
      custodyContext(p, 'device/' + enrollment + '/' + id + '/' + expires),
      material,
    )
  return { id, salt, expires, value, enrollment }
}
export async function unlockDevice(p: VaultScope, d: Awaited<ReturnType<typeof enrollDevice>>) {
  if (!(d.expires > Date.now())) throw Error('Device unlock has expired')
  return unwrapVaultKey(
    await deviceKey(d.id, d.salt),
    custodyContext(p, 'device/' + d.enrollment + '/' + d.id + '/' + d.expires),
    d.value,
  )
}
export const kitKey = importVaultKey
