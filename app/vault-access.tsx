'use client'
import { useState } from 'react'
import { identityContext, sealRecoveryCode, openRecoveryCode } from './read-share-crypto'
import {
  decryptPrivate,
  deriveCustodyMaterial,
  importVaultKey,
  newVaultKey,
} from './private-crypto'
import {
  wrapVaultKey,
  unwrapVaultKey,
  kitKey,
  custodyContext,
  enrollDevice,
  unlockDevice,
  type VaultScope,
} from './vault-custody'
function download(name: string, payload: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload)], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}
function recoveryContext(tenant: string, owner: string, recipient: string, id: string) {
  return JSON.stringify([
    'OpenPassword.custodian.v1',
    location.origin,
    tenant,
    owner,
    recipient,
    id,
  ])
}
export function VaultAccess({
  page,
  locked,
  open,
  api,
  vault,
}: {
  vault?: CryptoKey
  api: (p: string, b?: unknown, m?: string) => Promise<any>
  page: VaultScope
  locked: boolean
  open: (key: CryptoKey) => Promise<void>
}) {
  const [message, M] = useState(''),
    [code, C] = useState(''),
    [busy, B] = useState(false)
  const [envelope, setEnvelope] = useState('')
  const [devices, setDevices] = useState<{ id: string; label: string; expires: number }[]>([])
  const path = 'profile/vault/devices'
  const storage = custodyContext(page, 'local')
  async function verify(f: { key: string; passphrase: string }) {
    const material = await deriveCustodyMaterial(f.key, f.passphrase, page.tenant, page.profile),
      k = await importVaultKey(material)
    if (
      (await decryptPrivate(
        k,
        JSON.stringify(['OpenPassword.private.v1', page.tenant, page.profile, 'unlock']),
        page.check,
      )) !== 'OpenPassword private vault'
    )
      throw Error()
    return material
  }
  async function run(fn: () => Promise<void>) {
    B(true)
    M('')
    try {
      await fn()
    } catch {
      M(
        'Could not verify unlock material or authenticator support. Your usual vault unlock is available.',
      )
    } finally {
      B(false)
    }
  }
  return (
    <details
      onToggle={(e) => {
        if (!e.currentTarget.open) C('')
      }}
    >
      <summary>{locked ? 'Other ways to unlock' : 'Recovery and device unlock'}</summary>
      {locked ? (
        <>
          <button
            disabled={busy}
            onClick={() =>
              run(async () => {
                const d = JSON.parse(localStorage.getItem(storage) || 'null')
                if (!d || !(await api(path)).some((r: { id: string }) => r.id === d.enrollment))
                  throw Error()
                await open(await unlockDevice(page, d))
              })
            }
          >
            Unlock with enrolled authenticator
          </button>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              const f = new FormData(e.currentTarget)
              void run(async () => {
                const file = f.get('kit') as File
                if (file.size > 16384) throw Error()
                const v = JSON.parse(await file.text())
                if (v.format !== 'openpassword-recovery-1') throw Error()
                const recovered = await unwrapVaultKey(
                  await kitKey(String(f.get('code')).trim()),
                  custodyContext(page, 'recovery'),
                  v.box,
                )
                await open(recovered)
              })
            }}
          >
            <label>
              Recovery file
              <input type="file" name="kit" required />
            </label>
            <label>
              Offline recovery code
              <input type="password" name="code" required autoComplete="off" />
            </label>
            <button disabled={busy}>Unlock with recovery kit</button>
          </form>
        </>
      ) : (
        <>
          <p>
            A recovery kit opens this vault after account sign-in. Keep the downloaded file and its
            code in separate safe places. Copies of the pair can also unlock a matching offline
            backup.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              const f = new FormData(e.currentTarget),
                action = (e.nativeEvent as SubmitEvent).submitter?.getAttribute('value')
              e.currentTarget.reset()
              void run(async () => {
                const factors = {
                  key: String(f.get('key')).trim(),
                  passphrase: String(f.get('pass')),
                }
                const material = await verify(factors)
                if (action === 'device') {
                  const d = await enrollDevice(page, material, () =>
                    api(path, { label: String(f.get('device') || 'My browser') }),
                  )
                  localStorage.setItem(storage, JSON.stringify(d))
                  M('Authenticator enabled on this browser for 30 days.')
                  return
                }
                const code = newVaultKey(),
                  box = await wrapVaultKey(
                    await kitKey(code),
                    custodyContext(page, 'recovery'),
                    material,
                  )
                if (action === 'custodian') {
                  const c = JSON.parse(String(f.get('card')))
                  if (c.tenant !== page.tenant || c.profile === page.profile) throw Error()
                  const { pub } = await api(
                    'profile/vault/read/recipient/' + encodeURIComponent(c.profile),
                  )
                  const id = crypto.randomUUID(),
                    wrapped = await sealRecoveryCode(
                      pub,
                      c.fingerprint,
                      recoveryContext(page.tenant, page.profile, c.profile, id),
                      code,
                    )
                  download('openpassword-recovery.json', { format: 'openpassword-recovery-1', box })
                  setEnvelope(
                    JSON.stringify({
                      format: 'openpassword-custodian-1',
                      tenant: page.tenant,
                      owner: page.profile,
                      recipient: c.profile,
                      id,
                      wrapped,
                    }),
                  )
                  C('')
                  M(
                    'Keep your recovery file. Give only the custodian envelope to the designated person. Both parts are required.',
                  )
                  return
                }
                download('openpassword-recovery.json', { format: 'openpassword-recovery-1', box })
                C(code)
              })
            }}
          >
            <label>
              Confirm saved vault key
              <input required name="key" type="password" autoComplete="off" />
            </label>
            <label>
              Confirm vault passphrase
              <input required name="pass" type="password" autoComplete="off" />
            </label>
            <button value="kit" disabled={busy}>
              Download recovery file
            </button>
            <label>
              Optional custodian recipient card
              <input name="card" />
            </label>
            <button value="custodian" disabled={busy}>
              Create custodian-assisted kit
            </button>
            <label>
              Device name
              <input name="device" maxLength={80} placeholder="My browser" />
            </label>
            <button value="device" disabled={busy}>
              Enable 30-day device unlock
            </button>
          </form>
          {envelope && (
            <button onClick={() => download('openpassword-custodian.json', JSON.parse(envelope))}>
              Download custodian envelope
            </button>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault()
              const f = new FormData(e.currentTarget)
              void run(async () => {
                const file = f.get('envelope') as File
                if (!vault || file.size > 16384) throw Error()
                const v = JSON.parse(await file.text())
                if (
                  v.format !== 'openpassword-custodian-1' ||
                  v.tenant !== page.tenant ||
                  v.recipient !== page.profile
                )
                  throw Error()
                const identity = await api('profile/vault/read/identity')
                C(
                  await openRecoveryCode(
                    vault,
                    identity.sealed,
                    identityContext(page.tenant, page.profile),
                    recoveryContext(v.tenant, v.owner, v.recipient, v.id),
                    v.wrapped,
                  ),
                )
                M('Verify the owner independently before returning their recovery code.')
              })
            }}
          >
            <label>
              Custodian envelope
              <input type="file" name="envelope" required />
            </label>
            <button disabled={busy}>Open custodian envelope</button>
          </form>
          {code && (
            <p>
              Save this recovery code separately <code>{code}</code>
            </p>
          )}
          <button disabled={busy} onClick={() => run(async () => setDevices(await api(path)))}>
            Manage enrolled devices
          </button>
          {devices.map((d) => (
            <p key={d.id}>
              {d.label} · expires {new Date(d.expires).toLocaleDateString()}{' '}
              <button
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await api(path + '/' + d.id, undefined, 'DELETE')
                    setDevices(await api(path))
                    M('Device revoked for future online unlocks.')
                  })
                }
              >
                Revoke device
              </button>
            </p>
          ))}
          <button
            onClick={() => {
              localStorage.removeItem(storage)
              M('Local device unlock removed from this browser.')
            }}
          >
            Forget this browser
          </button>
        </>
      )}
      {message && <p role="status">{message}</p>}
    </details>
  )
}
