'use client'
import { useState } from 'react'
import { ReadGroups } from './read-groups'
import {
  fingerprint,
  identityContext,
  openCopy,
  sealCopy,
  sharingIdentity,
  type Binding,
} from './read-share-crypto'
type Props = {
  api: (p: string, b?: unknown, m?: string) => Promise<any>
  vault: CryptoKey
  tenant: string
  profile: string
  item?: { id: string; title: string; revision: number }
  secret: () => Promise<string>
}
export function ReadSharing({ api, vault, tenant, profile, item, secret }: Props) {
  const [card, setCard] = useState(''),
    [rows, setRows] = useState<Binding[]>([]),
    [revealed, setRevealed] = useState(''),
    [next, setNext] = useState(''),
    [status, setStatus] = useState(''),
    [busy, setBusy] = useState(false)
  const root = 'profile/vault/read'
  const [loaded, setLoaded] = useState(false)
  async function run(f: () => Promise<void>) {
    setBusy(true)
    setStatus('')
    setRevealed('')
    try {
      await f()
    } catch {
      setStatus(
        'Could not complete the request. Check the recipient details, expiry and item revision.',
      )
    } finally {
      setBusy(false)
    }
  }
  async function list(after = '') {
    const r = await api(root + (after ? '?after=' + encodeURIComponent(after) : ''))
    setLoaded(true)
    setRows(r.rows)
    setNext(r.next || '')
  }
  return (
    <details
      onToggle={(e) => {
        if (!e.currentTarget.open) {
          setRevealed('')
          setCard('')
        }
      }}
    >
      <summary>Human read access</summary>
      <p>
        A reader can reveal and keep the credential. For an agent that only needs to make calls, use
        a gateway connection.
      </p>
      <button
        disabled={busy}
        onClick={() =>
          run(async () => {
            let identity = await api(root + '/identity')
            if (!identity.pub) {
              identity = await sharingIdentity(vault, identityContext(tenant, profile))
              await api(root + '/identity', identity)
            }
            setCard(
              JSON.stringify({ tenant, profile, fingerprint: await fingerprint(identity.pub) }),
            )
          })
        }
      >
        Show my recipient card
      </button>
      {card && (
        <p>
          Give this card to the owner over a channel where they know you. <code>{card}</code>
        </p>
      )}
      <ReadGroups
        api={api}
        vault={vault}
        tenant={tenant}
        profile={profile}
        item={item}
        secret={secret}
      />
      {item && (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            const f = new FormData(e.currentTarget)
            void run(async () => {
              const c = JSON.parse(String(f.get('card')))
              if (c.tenant !== tenant || c.profile === profile) throw Error()
              const { pub } = await api(root + '/recipient/' + encodeURIComponent(c.profile))
              const b = {
                id: crypto.randomUUID(),
                tenant,
                owner: profile,
                recipient: c.profile,
                item: item.id,
                revision: item.revision,
                expires: Date.now() + Number(f.get('days')) * 86400000,
              }
              const encrypted = await sealCopy(pub, c.fingerprint, b, item.title, await secret())
              await api(root, {
                id: b.id,
                item: b.item,
                recipient: b.recipient,
                revision: b.revision,
                expires: b.expires,
                pub,
                ...encrypted,
              })
              await list()
              setStatus('Read access granted.')
            })
          }}
        >
          <h3>Share a readable copy of {item.title}</h3>
          <label>
            Verified recipient card
            <input name="card" required />
          </label>
          <label>
            Days of read access
            <input name="days" type="number" min="1" max="365" defaultValue="7" required />
          </label>
          <button disabled={busy}>Grant read access</button>
        </form>
      )}
      <button disabled={busy} onClick={() => run(() => list())}>
        List shared items
      </button>
      {loaded && !rows.length && <p>No active read shares on this page.</p>}
      {rows.map((b) => (
        <article key={b.id}>
          <p>
            Item {b.item} · from {b.owner} to {b.recipient} · expires{' '}
            {new Date(b.expires).toLocaleString()}
          </p>
          {profile === b.owner ? (
            <button
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await api(root + '/' + b.id, undefined, 'DELETE')
                  await list()
                  setStatus('Future reads revoked.')
                })
              }
            >
              Revoke read access
            </button>
          ) : (
            <button
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const entry = await api(root + '/' + b.id),
                    identity = await api(root + '/identity')
                  const clear = await openCopy(
                    vault,
                    identity.sealed,
                    entry,
                    entry.wrapped,
                    entry.value,
                  )
                  setRevealed(clear.title + ' — ' + clear.secret)
                })
              }
            >
              Reveal shared item
            </button>
          )}
        </article>
      ))}
      {next && (
        <button disabled={busy} onClick={() => run(() => list(next))}>
          Next shares
        </button>
      )}
      {revealed && (
        <p>
          <code>{revealed}</code> <button onClick={() => setRevealed('')}>Hide shared value</button>
        </p>
      )}
      {status && <p role="status">{status}</p>}
    </details>
  )
}
