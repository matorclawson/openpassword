import {
  decryptPrivate,
  derivePrivateKey,
  encryptPrivate,
  openPrivateValue,
  sealPrivateItem,
} from './private-crypto'

type Page = {
  tenant: string
  profile: string
  scheme: string
  check: string
  next: string | null
  items: { id: string; revision: number; value: string }[]
}
type Request = (path: string, body?: object) => Promise<any>

export async function upgradePrivateVault(
  request: Request,
  original: Page,
  oldKey: CryptoKey,
  savedKey: string,
  passphrase: string,
  signal: AbortSignal,
  progress: (count: number) => void,
) {
  const context = (id: string) =>
    JSON.stringify(['OpenPassword.private.v1', original.tenant, original.profile, id])
  const newKey = await derivePrivateKey(savedKey, passphrase, original.tenant, original.profile)
  signal.throwIfAborted()
  const { id } = await request('profile/vault/upgrade', {})
  let after: string | null = null,
    count = 0
  do {
    signal.throwIfAborted()
    const page: Page = await request(
      'profile/vault' + (after ? '?after=' + encodeURIComponent(after) : ''),
    )
    if (
      page.tenant !== original.tenant ||
      page.profile !== original.profile ||
      page.check !== original.check ||
      page.scheme !== 'raw-v1'
    )
      throw Error('Vault changed during upgrade')
    for (const row of page.items) {
      signal.throwIfAborted()
      const aad = context(row.id),
        field = context('value/' + row.id)
      const old = JSON.parse(await decryptPrivate(oldKey, aad, row.value))
      if (
        !old ||
        typeof old.title !== 'string' ||
        typeof old.protectedValue !== 'string' ||
        Object.keys(old).some((k) => !['title', 'itemKey', 'protectedValue'].includes(k))
      )
        throw Error('Unrecognized private item format')
      const secret = await openPrivateValue(oldKey, field, old)
      const value = await sealPrivateItem(newKey, aad, field, old.title, secret)
      const verified = JSON.parse(await decryptPrivate(newKey, aad, value))
      if (
        verified.title !== old.title ||
        (await openPrivateValue(newKey, field, verified)) !== secret
      )
        throw Error('Item verification failed')
      signal.throwIfAborted()
      await request('profile/vault/upgrade/' + id + '/item', {
        id: row.id,
        revision: row.revision,
        value,
      })
      progress(++count)
    }
    after = page.next
  } while (after)
  const check = await encryptPrivate(newKey, context('unlock'), 'OpenPassword private vault')
  signal.throwIfAborted()
  const commit = () => request('profile/vault/upgrade/' + id + '/commit', { check })
  try {
    await commit()
  } catch (error) {
    signal.throwIfAborted()
    if (!(error instanceof TypeError)) throw error
    try {
      await commit()
    } catch {
      throw Error(
        'Commit confirmation unavailable. Lock and reopen the vault. If prompted for a passphrase, use both new factors. Otherwise use your old key and restart the upgrade.',
      )
    }
  }
}
