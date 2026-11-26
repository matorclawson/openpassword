type BrowserPasskeys = typeof PublicKeyCredential & {
  parseCreationOptionsFromJSON(v: unknown): PublicKeyCredentialCreationOptions
  parseRequestOptionsFromJSON(v: unknown): PublicKeyCredentialRequestOptions
}
export async function usePasskey(options: unknown, enroll = false) {
  const api = window.PublicKeyCredential as BrowserPasskeys | undefined
  if (!api?.parseRequestOptionsFromJSON || !api.parseCreationOptionsFromJSON)
    throw Error('This browser does not support passkey sign-in.')
  const credential = enroll
    ? await navigator.credentials.create({ publicKey: api.parseCreationOptionsFromJSON(options) })
    : await navigator.credentials.get({ publicKey: api.parseRequestOptionsFromJSON(options) })
  if (!credential) throw Error('Authenticator cancelled.')
  return (credential as PublicKeyCredential & { toJSON(): unknown }).toJSON()
}
