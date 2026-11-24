'use client'
import { useEffect, useState, type FormEvent } from 'react'
type Request = (path: string, body?: unknown, method?: string) => Promise<any>
const labels: Record<string, string> = { google: 'Google', github: 'GitHub', apple: 'Apple' }
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
              {setup && (
                <p>
                  Use the setup code from the machine running OpenPassword. This account will manage
                  your workspace.
                </p>
              )}
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
                    On your laptop, run <code>openpassword setup-code --ssh user@host</code>. Use
                    your deployment’s trusted SSH host or alias. For a user installation, append{' '}
                    <code>--user</code>.
                  </p>
                  <p>
                    On the deployment host itself, a user installation can run{' '}
                    <code>openpassword setup-code</code>. Enter the ten-minute code here. After
                    sign-in, open Workspace → CLI hosts and issue a host enrollment token. Paste it
                    into <code>openpassword host connect</code> on the agent machine. Each agent
                    then requests its own grant.
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
            {setup && (
              <details>
                <summary>Create administrator with social sign-in</summary>
                <BootstrapSocial request={request} origin={status.origin} error={setError} />
              </details>
            )}
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
      <p>Configure the OAuth apps available to profiles on this installation.</p>
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
                window.dispatchEvent(new Event('signin-apps-updated'))
                M('Saved. You can link this provider under My profile.')
              })
            }}
          >
            <p>
              <a
                href={
                  p.provider === 'google'
                    ? 'https://console.cloud.google.com/auth/clients'
                    : p.provider === 'apple'
                      ? 'https://developer.apple.com/account/resources/identifiers/list'
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
              {p.provider === 'apple' ? 'Services ID' : 'Client ID'}
              <input name="client" defaultValue={p.client} required />
            </label>
            <label>
              {p.provider === 'apple' ? 'Apple signed client secret (JWT)' : 'Client secret'}
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
                    window.dispatchEvent(new Event('signin-apps-updated'))
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

function BootstrapSocial({
  request,
  origin,
  error,
}: {
  request: Request
  origin: string
  error: (m: string) => void
}) {
  const [provider, P] = useState('google')
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault()
        const setup = Object.fromEntries(new FormData(e.currentTarget))
        try {
          location.assign(
            (await request('auth/' + provider + '/start', { link: false, setup })).url,
          )
        } catch (ex) {
          error((ex as Error).message)
        }
      }}
    >
      <label>
        Sign-in provider
        <select value={provider} onChange={(e) => P(e.target.value)}>
          {Object.entries(labels).map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <p>Register this callback in your provider’s web application settings.</p>
      <input
        aria-label="Registration callback"
        value={origin + '/api/auth/' + provider + '/callback'}
        readOnly
      />
      <label>
        Installation setup code
        <input name="token" type="password" required />
      </label>
      <label>
        {provider === 'apple' ? 'Services ID' : 'OAuth client ID'}
        <input name="client" required />
      </label>
      <label>
        {provider === 'apple' ? 'Apple signed client secret (JWT)' : 'OAuth client secret'}
        <input name="secret" type="password" required />
      </label>
      <button>Continue with {labels[provider]}</button>
    </form>
  )
}
export function Profile({ request }: { request: Request }) {
  const [profile, P] = useState<{
      role: string
      username?: string
      providers: { provider: string; linked: number }[]
    }>(),
    [message, M] = useState('')
  async function load() {
    P(await request('profile'))
  }
  useEffect(() => {
    const refresh = () => load().catch((e) => M(e.message))
    refresh()
    window.addEventListener('signin-apps-updated', refresh)
    return () => window.removeEventListener('signin-apps-updated', refresh)
  }, [])
  async function act(fn: () => Promise<void>) {
    try {
      await fn()
      await load()
      M('Profile updated.')
    } catch (e) {
      M((e as Error).message)
    }
  }
  return (
    <section className="authentication">
      <h2>My profile</h2>
      <p>Workspace role · {profile?.role}</p>
      <details>
        <summary>
          {profile?.username ? 'Change username or password' : 'Add username and password'}
        </summary>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            const form = e.currentTarget,
              data = Object.fromEntries(new FormData(form))
            void act(async () => {
              await request('profile/password', data)
              form.reset()
            })
          }}
        >
          <label>
            Username
            <input name="username" defaultValue={profile?.username} required />
          </label>
          <label>
            New password
            <input
              name="password"
              type="password"
              minLength={12}
              autoComplete="new-password"
              required
            />
          </label>
          <button>Save password</button>
        </form>
        {profile?.username && (
          <button onClick={() => act(() => request('profile/password', undefined, 'DELETE'))}>
            Remove password
          </button>
        )}
      </details>
      {profile?.providers.map(({ provider, linked }) => (
        <button
          key={provider}
          onClick={() =>
            act(async () => {
              if (linked) await request('profile/' + provider, undefined, 'DELETE')
              else
                location.assign((await request('auth/' + provider + '/start', { link: true })).url)
            })
          }
        >
          {linked ? 'Unlink' : 'Link'} {labels[provider]}
        </button>
      ))}
      {message && <p role="status">{message}</p>}
    </section>
  )
}
