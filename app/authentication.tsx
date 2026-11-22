'use client'
import { useEffect, useState, type FormEvent } from 'react'
type Request = (path: string, body?: unknown, method?: string) => Promise<any>
const labels: Record<string, string> = { google: 'Google', github: 'GitHub' }
export function ConsoleLogin({
  request,
  done,
}: {
  request: Request
  done: (setup: boolean) => Promise<void>
}) {
  const [status, setStatus] = useState<{ setup: boolean; origin: string; providers: string[] }>()
  const [member, setMember] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  useEffect(() => {
    request('auth/status')
      .then(setStatus)
      .catch((e) => setError(e.message))
    if (new URLSearchParams(location.search).get('signin') === 'failed')
      setError('Sign-in was unsuccessful. Try the linked account or use your password.')
  }, [request])
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const data = Object.fromEntries(new FormData(e.currentTarget))
    setBusy(true)
    setError('')
    try {
      if (member) await request('admin/login', data)
      else await request(status?.setup ? 'auth/setup' : 'auth/password', data)
      await done(!!status?.setup && !member)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const setup = status?.setup && !member
  return (
    <section className="loginForm">
      <h1>
        {setup
          ? 'Create your administrator account'
          : member
            ? 'Workspace member sign-in'
            : 'Sign in to OpenPassword'}
      </h1>
      {status && location.origin !== status.origin ? (
        <p role="alert">
          This broker is configured for {status.origin}. On the deployment host, set
          OPENPASSWORD_WEB_ORIGIN to this console’s HTTPS origin and restart the broker, or open the
          configured address through a local tunnel.
        </p>
      ) : (
        status && (
          <>
            <form onSubmit={submit} key={String(setup) + String(member)}>
              {(setup || member) && (
                <label>
                  {member ? 'Workspace access token' : 'Setup code'}
                  <input required type="password" name="token" autoComplete="off" />
                </label>
              )}
              {setup && (
                <details>
                  <summary>Where do I find the setup code?</summary>
                  <p>
                    Open a terminal on the machine running OpenPassword. For a remote server,
                    connect through SSH or its cloud console.
                  </p>
                  <p>
                    For a user installation, run <code>cat ~/.openpassword/operator.token</code>.
                    For the systemd service, run{' '}
                    <code>sudo cat /var/lib/openpassword/operator.token</code>. A custom
                    installation prints the exact path at startup.
                  </p>
                </details>
              )}
              {!member && (
                <>
                  <label>
                    Username
                    <input name="username" autoComplete="username" maxLength={80} required />
                  </label>
                  <label>
                    {setup ? 'Choose a password (12 characters minimum)' : 'Password'}
                    <input
                      type="password"
                      name="password"
                      minLength={setup ? 12 : 1}
                      maxLength={256}
                      autoComplete={setup ? 'new-password' : 'current-password'}
                      required
                    />
                  </label>
                </>
              )}
              <button className="primary" disabled={busy}>
                {setup ? 'Create administrator' : 'Sign in'}
              </button>
            </form>
            {!setup &&
              !member &&
              status.providers.map((p) => (
                <button
                  key={p}
                  disabled={busy}
                  onClick={async () => {
                    try {
                      setBusy(true)
                      location.assign((await request('auth/' + p + '/start', { link: false })).url)
                    } catch (e) {
                      setError((e as Error).message)
                      setBusy(false)
                    }
                  }}
                >
                  Continue with {labels[p]}
                </button>
              ))}
            <button
              onClick={() => {
                setMember(!member)
                setError('')
              }}
            >
              {member ? 'Administrator sign-in' : 'Use a workspace access token'}
            </button>
          </>
        )
      )}
      {!status && !error && <p>Loading sign-in options…</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
type Provider = { provider: string; client: string; callback: string; linked: boolean }
export function Authentication({ request }: { request: Request }) {
  const [apps, A] = useState<Provider[]>([]),
    [message, M] = useState(''),
    [busy, B] = useState(false)
  async function load() {
    A(await request('admin/authentication'))
  }
  useEffect(() => {
    load().catch((e) => M(e.message))
  }, [])
  async function act(f: () => Promise<void>) {
    B(true)
    M('')
    try {
      await f()
      await load()
    } catch (e) {
      M((e as Error).message)
    } finally {
      B(false)
    }
  }
  return (
    <section className="authentication">
      <h2>Authentication</h2>
      <p>
        Your username and password are ready. To add social sign-in, register an OAuth app with the
        provider, then link your account.
      </p>
      {apps.map((p) => (
        <details key={p.provider}>
          <summary>
            {labels[p.provider]} · {p.linked ? 'Linked' : p.client ? 'Ready to link' : 'Optional'}
          </summary>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              const form = e.currentTarget,
                data = Object.fromEntries(new FormData(form))
              void act(async () => {
                await request('admin/authentication/' + p.provider, data)
                form.reset()
                M('Saved. Link your account to enable sign-in.')
              })
            }}
          >
            <p>
              <a
                href={
                  p.provider === 'google'
                    ? 'https://console.cloud.google.com/auth/clients'
                    : 'https://github.com/settings/developers'
                }
                target="_blank"
                rel="noreferrer"
              >
                Open {labels[p.provider]} developer settings
              </a>
            </p>
            <label>
              Callback URL
              <input value={p.callback} readOnly onFocus={(e) => e.target.select()} />
            </label>
            <label>
              Client ID
              <input name="client" defaultValue={p.client} required />
            </label>
            <label>
              Client secret
              <input type="password" name="secret" autoComplete="new-password" required />
            </label>
            <button disabled={busy}>Save credentials</button>
          </form>
          {p.client && (
            <>
              <button
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    location.assign(
                      (await request('auth/' + p.provider + '/start', { link: true })).url,
                    )
                  })
                }
              >
                Link my {labels[p.provider]} account
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    await request('admin/authentication/' + p.provider, undefined, 'DELETE')
                  })
                }
              >
                Remove {labels[p.provider]} sign-in
              </button>
            </>
          )}
        </details>
      ))}
      {message && <p role="status">{message}</p>}
    </section>
  )
}
