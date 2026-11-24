'use client'
import { useState } from 'react'
type Host = { id: string; label: string; revoked: number; enrolled: number; expires: number }
export function HostDirectory({
  hosts,
  request,
  reload,
}: {
  hosts: Host[]
  request: (path: string, body?: unknown, method?: string) => Promise<any>
  reload: () => Promise<unknown>
}) {
  const [ticket, T] = useState(''),
    [error, E] = useState(''),
    [busy, B] = useState(false)
  async function act(fn: () => Promise<void>) {
    B(true)
    E('')
    try {
      await fn()
      await reload()
    } catch (e) {
      E((e as Error).message)
    } finally {
      B(false)
    }
  }
  return (
    <section className="authentication">
      <h2>CLI hosts</h2>
      <p>
        Approve one bridge per machine. Each agent on that machine requests its own grant.
        Connecting the first host disables standalone agent tokens in this workspace. Re-pair
        existing agents through their host.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          const label = new FormData(e.currentTarget).get('label')
          void act(async () => T((await request('admin/hosts', { label })).ticket))
        }}
      >
        <label>
          Host name
          <input name="label" required maxLength={100} />
        </label>
        <button disabled={busy}>Issue host enrollment token</button>
      </form>
      {ticket && (
        <section>
          <p>
            Run <code>openpassword host connect</code> as the bridge service user. Paste this token
            within ten minutes.
          </p>
          <code>{ticket}</code>
          <button onClick={() => T('')}>Hide token</button>
        </section>
      )}
      {hosts.map((h) => (
        <article key={h.id}>
          <strong>{h.label}</strong>
          <small>
            {h.revoked
              ? 'Revoked'
              : h.enrolled
                ? 'Connected'
                : h.expires > Date.now()
                  ? 'Awaiting enrollment'
                  : 'Expired'}
          </small>
          {!h.revoked && (
            <button
              disabled={busy}
              onClick={() =>
                act(async () => {
                  await request('admin/hosts/' + h.id, undefined, 'DELETE')
                  T('')
                })
              }
            >
              Revoke host {h.label}
            </button>
          )}
        </article>
      ))}
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
