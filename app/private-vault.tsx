'use client'
import { useEffect, useState, type FormEvent } from 'react'
import {
  newVaultKey,
  importVaultKey,
  encryptPrivate,
  decryptPrivate,
  sealPrivateItem,
  openPrivateValue,
  derivePrivateKey,
  privateScheme,
} from './private-crypto'
import { sealInput } from './intake'
type Api = (path: string, body?: unknown, method?: string) => Promise<any>
type Item = {
  id: string
  revision: number
  title: string
  itemKey?: string
  protectedValue: string
  connections: { id: string; label: string }[]
}
type Props = { request: Api; providers: Record<string, { name: string }> }
export function PrivateVault(props: Props) {
  const [epoch, setEpoch] = useState(0)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const lock = () => setEpoch((n) => n + 1)
    const reset = () => {
      clearTimeout(timer)
      timer = setTimeout(lock, 300000)
    }
    const hidden = () => {
      if (document.hidden) lock()
    }
    reset()
    window.addEventListener('pointerdown', reset)
    window.addEventListener('keydown', reset)
    document.addEventListener('visibilitychange', hidden)
    window.addEventListener('pagehide', lock)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('pointerdown', reset)
      window.removeEventListener('keydown', reset)
      document.removeEventListener('visibilitychange', hidden)
      window.removeEventListener('pagehide', lock)
    }
  }, [])
  return <PrivateSession key={epoch} {...props} lock={() => setEpoch((n) => n + 1)} />
}
function PrivateSession({ request, providers, lock }: Props & { lock: () => void }) {
  const [ticket, setTicket] = useState('')
  const [revealed, showSecret] = useState('')
  const [page, P] = useState<any>(),
    [key, K] = useState<CryptoKey>(),
    [recovery, R] = useState(''),
    [items, I] = useState<Item[]>([]),
    [selected, S] = useState<Item>(),
    [mode, M] = useState(''),
    [error, E] = useState(''),
    [busy, B] = useState(false),
    [notice, N] = useState('')
  useEffect(() => {
    request('profile/vault')
      .then(P)
      .catch(() => E('Could not load your private vault.'))
  }, [request])
  const context = (p: any, id: string) =>
    JSON.stringify(['OpenPassword.private.v1', p.tenant, p.profile, id])
  async function show(k: CryptoKey, p: any) {
    if ((await decryptPrivate(k, context(p, 'unlock'), p.check)) !== 'OpenPassword private vault')
      throw Error('Unlock failed')
    const rows = await Promise.all(
      p.items.map(async (i: any) => ({
        ...JSON.parse(await decryptPrivate(k, context(p, i.id), i.value)),
        id: i.id,
        revision: i.revision,
        connections: i.connections,
      })),
    )
    showSecret('')
    P(p)
    I(rows)
    K(k)
    R('')
    S(undefined)
    M('')
  }
  async function act(fn: () => Promise<void>) {
    B(true)
    E('')
    N('')
    try {
      await fn()
    } catch (e) {
      E(
        e instanceof DOMException
          ? 'Could not unlock or authenticate this vault item.'
          : (e as Error).message,
      )
    } finally {
      B(false)
    }
  }
  function form(fn: (f: FormData) => Promise<void>) {
    return (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault()
      const f = new FormData(e.currentTarget)
      void act(() => fn(f))
    }
  }
  return (
    <section className="authentication">
      <h1>Private vault</h1>
      {!key ? (
        <>
          <p>
            Your browser encrypts item names and secrets. Save your private vault key separately so
            you can unlock them on another device.
          </p>
          {page && !page.check && !recovery && (
            <button onClick={() => R(newVaultKey())}>Create my private vault</button>
          )}
          {recovery && (
            <>
              <label>
                Save this private vault key<code>{recovery}</code>
              </label>
              <p>
                OpenPassword cannot recover this key. Losing the last copy means losing access to
                your private items.
              </p>
            </>
          )}
          {page && (page.check || recovery) && (
            <form
              onSubmit={form(async (f) => {
                if (page.check && page.scheme && !['raw-v1', privateScheme].includes(page.scheme))
                  throw Error('Update the client to open this vault format')
                const entered = String(f.get('key')).trim(),
                  k =
                    !page.check || page.scheme === privateScheme
                      ? await derivePrivateKey(
                          entered,
                          String(f.get('passphrase')),
                          page.tenant,
                          page.profile,
                        )
                      : await importVaultKey(entered)
                if (!page.check) {
                  if (entered !== recovery) throw Error('Enter the key you saved')
                  await request('profile/vault', {
                    scheme: privateScheme,
                    check: await encryptPrivate(
                      k,
                      context(page, 'unlock'),
                      'OpenPassword private vault',
                    ),
                  })
                }
                await show(k, await request('profile/vault'))
              })}
            >
              <label>
                {recovery ? 'Confirm your saved key' : 'Private vault key'}
                <input type="password" name="key" required autoComplete="off" />
              </label>
              {(!page.check || page.scheme === privateScheme) && (
                <label>
                  Vault passphrase
                  <input
                    name="passphrase"
                    type="password"
                    autoComplete={page.check ? 'current-password' : 'new-password'}
                    minLength={12}
                    required
                  />
                </label>
              )}
              {(!page.check || page.scheme === privateScheme) && (
                <p>
                  Keep your vault passphrase and saved key separately. You need both to unlock this
                  vault.
                </p>
              )}
              <button disabled={busy}>Unlock private vault</button>
            </form>
          )}
        </>
      ) : (
        <>
          <button onClick={lock}>Lock private vault</button>{' '}
          <button
            onClick={() => {
              showSecret('')
              S(undefined)
              M('edit')
            }}
          >
            Add private item
          </button>
          {items.map((i) => (
            <article key={i.id}>
              <button
                onClick={() => {
                  showSecret('')
                  S(i)
                  M('detail')
                  N('')
                }}
              >
                {i.title}
              </button>
              <small>
                {i.connections.length
                  ? i.connections.length + ' gateway connections'
                  : 'Only in your private vault'}
              </small>
            </article>
          ))}
          {page.next && (
            <button
              disabled={busy}
              onClick={() =>
                act(async () => show(key, await request('profile/vault?after=' + page.next)))
              }
            >
              Next page
            </button>
          )}
          {items.length > 0 && (
            <button
              disabled={busy}
              onClick={() => act(async () => show(key, await request('profile/vault')))}
            >
              First page
            </button>
          )}
          {selected && mode === 'detail' && (
            <section>
              <h2>{selected.title}</h2>
              <p>••••••••</p>
              <button
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    showSecret(
                      await openPrivateValue(key, context(page, 'value/' + selected.id), selected),
                    )
                    M('reveal')
                  })
                }
              >
                Reveal secret
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    showSecret(
                      await openPrivateValue(key, context(page, 'value/' + selected.id), selected),
                    )
                    M('edit')
                  })
                }
              >
                Edit item
              </button>
              <button onClick={() => M('delegate')}>Delegate to gateway</button>
              {selected.connections.map((c) => (
                <a key={c.id} href={'/connections#' + c.id}>
                  {c.label}
                </a>
              ))}
              {!selected.connections.length && (
                <button onClick={() => M('delete')}>Delete item…</button>
              )}
            </section>
          )}
          {selected && mode === 'delete' && (
            <>
              <p>Delete {selected.title} from your private vault?</p>
              <button
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    await request('profile/vault/items/' + selected.id, undefined, 'DELETE')
                    await show(key, await request('profile/vault'))
                  })
                }
              >
                Confirm deletion
              </button>
              <button onClick={() => M('detail')}>Cancel</button>
            </>
          )}
          {selected && mode === 'reveal' && (
            <>
              <code>{revealed}</code>
              <button
                onClick={() => {
                  showSecret('')
                  M('detail')
                }}
              >
                Hide secret
              </button>
            </>
          )}
          {ticket && (
            <section>
              <p>
                Give this receipt to the CLI operator. It can finish saving only this encrypted item
                for five minutes. Keep this web session signed in.
              </p>
              <code>{ticket}</code>
              <button onClick={() => setTicket('')}>Hide receipt</button>
            </section>
          )}
          {mode === 'edit' && (
            <form
              key={selected?.id || 'new'}
              onSubmit={form(async (f) => {
                const id = selected?.id || crypto.randomUUID()
                const value = await sealPrivateItem(
                  key,
                  context(page, id),
                  context(page, 'value/' + id),
                  String(f.get('title')),
                  String(f.get('secret')),
                )
                if (!selected && f.get('delivery') === 'cli') {
                  const prepared = await request('profile/vault/deposits', { id, value })
                  setTicket(prepared.ticket)
                  M('')
                  return
                }
                await request('profile/vault/items', {
                  id,
                  value,
                  revision: selected?.revision || 0,
                })
                await show(key, await request('profile/vault'))
                N('Private item saved')
              })}
            >
              <label>
                Item name
                <input name="title" defaultValue={selected?.title} maxLength={200} required />
              </label>
              <label>
                Secret
                <input
                  name="secret"
                  type="password"
                  defaultValue={revealed}
                  maxLength={8000}
                  autoComplete="new-password"
                  required
                />
              </label>
              {!selected && (
                <label>
                  <input type="checkbox" name="delivery" value="cli" />
                  Prepare a one-time CLI deposit
                </label>
              )}
              <button disabled={busy}>Save private item</button>
            </form>
          )}
          {mode === 'delegate' && selected && (
            <form
              onSubmit={form(async (f) => {
                const sealed = await sealInput(
                  await openPrivateValue(key, context(page, 'value/' + selected.id), selected),
                  await request('admin/intake', {}),
                )
                await request('admin/connections', {
                  private_source: selected.id,
                  ownership: 'personal',
                  provider: f.get('provider'),
                  label: f.get('label'),
                  external_identity: f.get('account'),
                  sealed,
                })
                await show(key, await request('profile/vault'))
                N('Gateway copy created. Issue a separate grant for each agent.')
              })}
            >
              <h2>Delegate {selected.title}</h2>
              <p>
                The gateway will hold a decryptable copy for unattended use. Later edits to this
                private item do not rotate that copy. Revoke it under Connections.
              </p>
              <label>
                Provider
                <select aria-label="Provider" name="provider">
                  {Object.entries(providers).map(([id, p]) => (
                    <option key={id} value={id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Gateway connection name
                <input name="label" required />
              </label>
              <label>
                Provider account identity
                <input name="account" required />
              </label>
              <button disabled={busy}>Authorize gateway copy</button>
              <button type="button" onClick={() => M('detail')}>
                Cancel
              </button>
            </form>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </section>
  )
}
