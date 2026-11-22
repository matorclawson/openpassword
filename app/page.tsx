'use client'
import { ApprovalPreview } from './approval-preview'
import { sealInput } from './intake'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  Vault,
  KeyRound,
  Blocks,
  Activity,
  Unplug,
  ShieldCheck,
  ArrowUpRight,
  Search,
  Plus,
  ChevronRight,
  Building2,
  LockKeyhole,
  LogOut,
  Layers,
  Command,
  X,
  Copy,
  Check,
  RefreshCw,
} from 'lucide-react'
import type { Provider } from '../packages/connectors'
type Connection = {
  id: string
  provider: string
  label: string
  identity: string
  active: number
  revision: number
}
type Grant = {
  id: string
  label: string
  connection_id: string
  active: number
  expires: number
  ops: string
}
type Approval = { id: string; actor: string; conn: string; op: string; preview: unknown }
type Workspace = {
  operation_stops: string[]
  provider_stops: string[]
  billing: { label: string; available: number; spent: number; held: number }[]
  items: { id: string; title: string; username: string; updated: number }[]
  tenant: string
  role: string
  paused: boolean
  apps: { id: string; label: string; audience: string; active: number }[]
  members: { id: string; label: string; role: string; active: number }[]
  workspaces: { id: string; label: string }[]
  providers: Record<string, Provider>
  connections: Connection[]
  grants: Grant[]
  approvals: Approval[]
  events: { action: string; subject: string; at: number; actor: string }[]
}
const tabs = [
  ['Connections', Vault],
  ['Integrations', Blocks],
  ['Access grants', KeyRound],
  ['Approvals', ShieldCheck],
  ['Audit log', Activity],
  ['Vault items', LockKeyhole],
  ['Workspace', Building2],
] as const
type Tab = (typeof tabs)[number][0]
const stamp = (n: number) => new Date(n).toLocaleString()
async function request(path: string, body?: unknown, method = body ? 'POST' : 'GET') {
  const r = await fetch('/api/' + path, {
    method,
    cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await r.json()
  if (!r.ok) throw Object.assign(Error(data.detail || 'Request failed'), { status: r.status })
  return data
}
function Brand() {
  return (
    <div className="brand">
      <span>
        <Vault size={26} />
      </span>
      OpenPassword
    </div>
  )
}
export default function Page() {
  const [w, W] = useState<Workspace | null>(null),
    [tab, T] = useState<Tab>('Connections'),
    [busy, B] = useState(false),
    [err, E] = useState(''),
    [q, Q] = useState(''),
    [modal, M] = useState(''),
    [selected, S] = useState(''),
    [grantId, G] = useState(''),
    [tokens, K] = useState(''),
    [checked, C] = useState<string[]>([]),
    [copied, CP] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null),
    search = useRef<HTMLInputElement>(null)
  async function load() {
    const data = await request('admin/workspace')
    W(data)
    return data as Workspace
  }
  useEffect(() => {
    load().catch((e) => {
      if (e.status !== 401) E(e.message)
    })
    if (location.pathname.startsWith('/approvals')) T('Approvals')
    if (location.pathname === '/device') T('Access grants')
  }, [])
  useEffect(() => {
    if (modal) dialog.current?.showModal()
    else dialog.current?.close()
  }, [modal])
  useEffect(() => {
    function key(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        search.current?.focus()
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])
  function close() {
    M('')
    K('')
    E('')
    CP(false)
  }
  async function work(f: () => Promise<void>) {
    if (busy) return
    B(true)
    E('')
    try {
      await f()
    } catch (e) {
      E((e as Error).message)
      if ((e as { status?: number }).status === 401) W(null)
    } finally {
      B(false)
    }
  }
  function go(t: Tab) {
    T(t)
    Q('')
    E('')
  }
  function show(m: string, id = '') {
    S(id)
    E('')
    K('')
    C([])
    G(w?.connections.find((c) => c.active)?.id || '')
    M(m)
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const f = Object.fromEntries(form)
    await work(async () => {
      if (!w) {
        await request('admin/login', { token: f.token })
        await load()
        return
      }
      let sealed: Awaited<ReturnType<typeof sealInput>> | undefined
      if (['oauth', 'connection', 'rotate'].includes(modal)) {
        const field = modal === 'oauth' ? 'client_secret' : 'secret'
        sealed = await sealInput(String(f[field]), await request('admin/intake', {}))
        delete f[field]
      }
      if (modal === 'oauth') {
        if (selected === 'notion') {
          const a = await request('admin/oauth/notion', {
            label: f.label,
            client_id: f.client_id,
            sealed,
          })
          location.assign(a.url)
          return
        }
        const data = await request('admin/oauth/google', {
          ...f,
          sealed,
          resources: String(f.resources || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        })
        location.assign(data.url)
        return
      }
      if (modal === 'app') {
        const a = await request('admin/apps', {
          label: f.label,
          callback: f.callback,
          audience: f.audience,
          days: Number(f.days),
          classes: form.getAll('classes'),
          member_write_allowed: f.member_write_allowed === 'on',
        })
        if (a.check_credential) {
          K(a.check_credential)
          await load()
          return
        }
      }
      if (modal === 'item') await request('admin/items', f)
      if (modal === 'deleteItem') await request('admin/items/' + selected, undefined, 'DELETE')
      if (modal === 'member') {
        const a = await request('admin/members', { label: f.label, role: f.role })
        K(a.token)
        await load()
        return
      }
      if (modal === 'connection')
        await request('admin/connections', {
          ...f,
          sealed,
          resources: String(f.resources || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          provider: selected,
        })
      if (modal === 'rotate') await request('admin/connections/' + selected + '/rotate', { sealed })
      if (modal === 'revoke')
        await request(
          'admin/' +
            (tab === 'Workspace' ? 'members' : tab === 'Access grants' ? 'grants' : 'connections') +
            '/' +
            selected,
          undefined,
          'DELETE',
        )
      if (modal === 'workspace') {
        const a = await request('admin/workspaces', { label: f.label })
        await request('admin/switch', a)
      }
      if (modal === 'grant') {
        if (
          f.budget &&
          (!f.model || !f.input_rate || !f.output_rate || !f.price_date || !f.price_source)
        )
          throw Error(
            'Enter the model, both rates, pricing date and pricing source for this budget.',
          )
        const a = await request('admin/grants', {
          connection_id: grantId,
          operations: checked,
          label: f.label,
          hours: Number(f.hours),
          ...(f.user_code ? { user_code: f.user_code } : {}),
          ...(f.draft_limit ? { draft_limit: Number(f.draft_limit) } : {}),
          ...(f.model
            ? {
                model_lease: {
                  model: f.model,
                  calls: Number(f.calls),
                  max_tokens: Number(f.max_tokens),
                  ...(f.budget
                    ? {
                        tariff: {
                          budget_micro_usd: Number(f.budget),
                          input: Number(f.input_rate),
                          output: Number(f.output_rate),
                          source: f.price_source,
                          as_of: f.price_date,
                        },
                      }
                    : {}),
                },
              }
            : {}),
        })
        if (a.access_token) {
          K(JSON.stringify(a, null, 2))
          await load()
          return
        }
      }
      await load()
      close()
    })
  }
  const error = err && (
    <p role="alert" className="error">
      {err}
    </p>
  )
  if (!w)
    return (
      <main className="login">
        <section className="loginArt">
          <Brand />
          <div className="dial">
            <Vault strokeWidth={0.8} />
          </div>
          <p>
            OpenPassword <span>/</span> Operator console
          </p>
        </section>
        <section className="loginForm">
          <LockKeyhole />
          <h1>Unlock your workspace</h1>
          <p>Use your workspace access token or the installation’s operator token.</p>
          <form onSubmit={submit}>
            <label>
              Operator token
              <input name="token" type="password" autoComplete="current-password" required />
            </label>
            {error}
            <button className="primary" disabled={busy}>
              Unlock workspace <ArrowUpRight size={17} />
            </button>
          </form>
        </section>
      </main>
    )
  const active = w.connections.filter((c) => c.active),
    name = w.workspaces.find((x) => x.id === w.tenant)?.label,
    selectedConnection = w.connections.find((x) => x.id === grantId)
  const includes = (...values: string[]) => values.join(' ').toLowerCase().includes(q.toLowerCase())
  const list = w.connections.filter((c) =>
    includes(c.label, c.identity, w.providers[c.provider].name),
  )
  const btn = (text: string, fn: () => void) => (
    <button type="button" onClick={fn}>
      {text}
    </button>
  )
  const creation =
    w.role === 'viewer'
      ? null
      : tab === 'Vault items'
        ? (['Add item', () => show('item')] as const)
        : tab === 'Connections'
          ? (['Add connection', () => show('connection', Object.keys(w.providers)[0])] as const)
          : tab === 'Access grants'
            ? (['Issue grant', () => show('grant')] as const)
            : null
  return (
    <div className="shell">
      <aside>
        <Brand />
        <label className="org">
          <Building2 size={18} />
          <select
            aria-label="Workspace"
            value={w.tenant}
            onChange={(e) => {
              const id = e.target.value
              if (id === '+') show('workspace')
              else
                void work(async () => {
                  await request('admin/switch', { id })
                  await load()
                })
            }}
          >
            {w.workspaces.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
            {w.role === 'owner' && <option value="+">New workspace…</option>}
          </select>
        </label>
        <nav aria-label="Workspace navigation">
          {tabs.map(([t, Icon]) => (
            <button key={t} aria-current={t === tab ? 'page' : undefined} onClick={() => go(t)}>
              <Icon size={18} />
              {t}
              {t === 'Approvals' && w.approvals.length > 0 && <b>{w.approvals.length}</b>}
            </button>
          ))}
        </nav>
        <a className="sourceLink" href="/openpassword-source.tar.gz" download>
          Download source
        </a>
        <button
          className="signout"
          onClick={() =>
            work(async () => {
              await request('admin/logout', {})
              W(null)
              close()
            })
          }
        >
          <LogOut size={16} /> Lock workspace
        </button>
      </aside>
      <main className="desk">
        <header>
          <span>
            {name} <ChevronRight size={14} /> {tab}
          </span>
          <button
            aria-label="Refresh workspace"
            disabled={busy}
            onClick={() =>
              work(async () => {
                await load()
              })
            }
          >
            <RefreshCw size={16} />
          </button>
        </header>
        <div className="canvas">
          <div className="heading">
            <div>
              <h1>{tab}</h1>
              <p>
                {
                  {
                    Connections: 'Manage the accounts your people and agents can use.',
                    Integrations: 'Explore providers and the operations each connection supports.',
                    'Access grants': 'Give a device access to specific operations on one account.',
                    Approvals: 'Review the exact request before a provider write.',
                    'Vault items': 'Store shared passwords and secure notes.',
                    Workspace: 'Manage workspace access and provider dispatch.',
                    'Audit log': 'Inspect recent access decisions and provider activity.',
                  }[tab]
                }
              </p>
            </div>
            {creation && (
              <button
                className="primary"
                disabled={busy || (tab === 'Access grants' && !active.length)}
                onClick={creation[1]}
              >
                <Plus size={17} />
                {creation[0]}
              </button>
            )}
          </div>
          {error && !modal && error}
          {tab === 'Connections' && (
            <div className="metrics">
              {[
                [Vault, 'Active connections', active.length],
                [
                  KeyRound,
                  'Active grants',
                  w.grants.filter((x) => x.active && x.expires > Date.now()).length,
                ],
                [ShieldCheck, 'Awaiting approval', w.approvals.length],
              ].map(([I, label, n]) => {
                const Icon = I as typeof Vault
                return (
                  <div key={String(label)}>
                    <Icon size={19} />
                    <span>{String(label)}</span>
                    <strong>{String(n)}</strong>
                  </div>
                )
              })}
            </div>
          )}
          <section className="panel">
            <div className="toolbar">
              <h2>
                {tab === 'Connections'
                  ? 'Credential vault'
                  : tab === 'Integrations'
                    ? 'Provider directory'
                    : tab === 'Access grants'
                      ? 'Device access'
                      : tab === 'Approvals'
                        ? 'Review queue'
                        : tab === 'Workspace'
                          ? 'Workspace settings'
                          : tab === 'Vault items'
                            ? 'Saved items'
                            : 'Recent events'}
              </h2>
              <label className="search">
                <Search size={15} />
                <input
                  ref={search}
                  aria-label={'Search ' + tab}
                  value={q}
                  onChange={(e) => Q(e.target.value)}
                  placeholder="Search…"
                />
                <Command size={12} />K
              </label>
            </div>
            {tab === 'Connections' &&
              (list.length ? (
                list.map((c) => (
                  <article key={c.id}>
                    <div className="mark">
                      <Layers />
                    </div>
                    <div className="grow">
                      <strong>{c.label}</strong>
                      <small>
                        {w.providers[c.provider].name} · {c.identity}
                      </small>
                    </div>
                    <span className={'pill ' + (c.active ? 'ok' : '')}>
                      {c.active ? 'Active' : 'Revoked'}
                    </span>
                    {!!c.active && w.role !== 'viewer' && (
                      <div className="actions">
                        {btn('Rotate', () => show('rotate', c.id))}
                        {btn('Revoke', () => show('revoke', c.id))}
                      </div>
                    )}
                  </article>
                ))
              ) : (
                <div className="empty">
                  <Vault />
                  <h3>{q ? 'No matching connections' : 'Your vault is ready'}</h3>
                  <p>
                    {q
                      ? 'Try a provider or account name.'
                      : 'Add a provider account, then grant access to the operations a device needs.'}
                  </p>
                  {!q && btn('Browse integrations', () => go('Integrations'))}
                </div>
              ))}
            {tab === 'Integrations' && (
              <div className="cards">
                {Object.entries(w.providers)
                  .filter(([, p]) => includes(p.name, p.group, ...p.actions.map((a) => a.id)))
                  .map(([id, p]) => (
                    <button key={id} className="card" onClick={() => show('provider', id)}>
                      <div className="mark">{p.name.slice(0, 2)}</div>
                      <small>{p.group}</small>
                      <strong>{p.name}</strong>
                      <span>
                        {p.actions.length} operations <ArrowUpRight size={14} />
                      </span>
                    </button>
                  ))}
              </div>
            )}
            {tab === 'Access grants' &&
              (w.grants.length ? (
                w.grants
                  .filter((g) => includes(g.label, g.id))
                  .map((g) => (
                    <article key={g.id}>
                      <KeyRound />
                      <div className="grow">
                        <strong>{g.label}</strong>
                        <small>
                          {w.connections.find((c) => c.id === g.connection_id)?.label} ·{' '}
                          {JSON.parse(g.ops).length} operations · Expires {stamp(g.expires)}
                        </small>
                      </div>
                      {g.active && g.expires > Date.now() && w.role !== 'viewer' ? (
                        btn('Revoke', () => show('revoke', g.id))
                      ) : (
                        <span className="pill">
                          {g.active && g.expires > Date.now() ? 'Active' : 'Inactive'}
                        </span>
                      )}
                    </article>
                  ))
              ) : (
                <div className="empty">
                  <KeyRound />
                  <h3>No grants issued</h3>
                  <p>
                    {active.length
                      ? 'Issue a grant to pair a device or generate scoped credentials.'
                      : 'Add a connection to issue your first grant.'}
                  </p>
                </div>
              ))}
            {tab === 'Approvals' &&
              (w.approvals.length ? (
                w.approvals
                  .filter((a) => includes(a.op, a.id))
                  .map((a) => (
                    <article key={a.id}>
                      <div className="grow">
                        <strong>{a.op}</strong>
                        <small>
                          {w.grants.find((g) => g.id === a.actor)?.label} →{' '}
                          {w.connections.find((c) => c.id === a.conn)?.label}
                        </small>
                        <ApprovalPreview value={a.preview} />
                        <div className="actions">
                          {[true, false].map((approve) => (
                            <button
                              key={String(approve)}
                              disabled={busy}
                              onClick={() =>
                                work(async () => {
                                  await request('admin/approvals/' + a.id, {
                                    approve,
                                    ...(a.op === 'loops.contacts.import_chunk'
                                      ? {
                                          shown_manifest_sha256: (
                                            a.preview as { manifest_sha256: string }
                                          ).manifest_sha256,
                                        }
                                      : {}),
                                  })
                                  await load()
                                })
                              }
                            >
                              {approve ? 'Approve request' : 'Deny'}
                            </button>
                          ))}
                        </div>
                      </div>
                    </article>
                  ))
              ) : (
                <div className="empty">
                  <ShieldCheck />
                  <h3>No pending requests</h3>
                  <p>Provider writes appear here before execution.</p>
                </div>
              ))}
            {tab === 'Vault items' &&
              (w.items.length ? (
                w.items
                  .filter((i) => includes(i.title, i.username))
                  .map((i) => (
                    <article key={i.id}>
                      <LockKeyhole />
                      <div className="grow">
                        <strong>{i.title}</strong>
                        <small>{i.username}</small>
                      </div>
                      {w.role !== 'viewer' && (
                        <div className="actions">
                          {btn('Reveal', () =>
                            work(async () => {
                              const a = await request('admin/items/' + i.id + '/reveal', {})
                              show('revealed', i.id)
                              K(a.value)
                            }),
                          )}
                          {btn('Delete', () => show('deleteItem', i.id))}
                        </div>
                      )}
                    </article>
                  ))
              ) : (
                <div className="empty">
                  <LockKeyhole />
                  <h3>No saved items</h3>
                  <p>Add a shared login or secure note to this workspace.</p>
                </div>
              ))}
            {tab === 'Workspace' && (
              <>
                {w.billing.map((b, i) => (
                  <article key={i}>
                    <div className="grow">
                      <strong>{b.label} · Model budget</strong>
                      <small>
                        {b.spent} spent · {b.held} reserved · {b.available} available (micro-USD)
                      </small>
                    </div>
                  </article>
                ))}
                <article>
                  <ShieldCheck />
                  <div className="grow">
                    <strong>Provider dispatch</strong>
                    <small>
                      {w.paused ? 'Paused' : 'Running'} · Applies to all workspace devices
                    </small>
                  </div>
                  {w.role === 'owner' &&
                    btn(w.paused ? 'Resume dispatch' : 'Pause dispatch', () =>
                      work(async () => {
                        await request('admin/dispatch', { paused: !w.paused })
                        await load()
                      }),
                    )}
                </article>
                {w.role === 'owner' && (
                  <>
                    <details>
                      <summary>Provider dispatch controls</summary>
                      {Object.entries(w.providers).map(([p, v]) => (
                        <div key={p}>
                          <article>
                            <div className="grow">
                              <strong>{v.name}</strong>
                              <small>{w.provider_stops.includes(p) ? 'Paused' : 'Running'}</small>
                            </div>
                            {btn(w.provider_stops.includes(p) ? 'Resume' : 'Pause', () =>
                              work(async () => {
                                await request('admin/dispatch/' + p, {
                                  paused: !w.provider_stops.includes(p),
                                })
                                await load()
                              }),
                            )}
                          </article>
                          <details>
                            <summary>{v.name} operations</summary>
                            {v.actions.map((a) => (
                              <article key={a.id}>
                                <strong className="grow">{a.id}</strong>
                                {btn(w.operation_stops.includes(a.id) ? 'Resume' : 'Pause', () =>
                                  work(async () => {
                                    await request('admin/dispatch/' + p + '/' + a.id, {
                                      paused: !w.operation_stops.includes(a.id),
                                    })
                                    await load()
                                  }),
                                )}
                              </article>
                            ))}
                          </details>
                        </div>
                      ))}
                    </details>
                    <article>
                      <Building2 />
                      <div className="grow">
                        <strong>Team members</strong>
                        <small>
                          Editors manage connections and grants. Viewers can inspect inventory and
                          audit events.
                        </small>
                      </div>
                      {btn('Add member', () => show('member'))}
                    </article>
                    <article>
                      <div className="grow">
                        <strong>Identity applications</strong>
                        <small>Allow an application to request a signed workspace identity.</small>
                      </div>
                      {btn('Register app', () => show('app'))}
                    </article>
                    {w.apps
                      .filter((a) => includes(a.label, a.audience))
                      .map((a) => (
                        <article key={a.id}>
                          <div className="grow">
                            <strong>{a.label}</strong>
                            <small>
                              {a.id} · {a.audience}
                            </small>
                          </div>
                          {btn(a.active ? 'Suspend' : 'Activate', () =>
                            work(async () => {
                              await request('admin/apps/' + a.id, { active: !a.active })
                              await load()
                            }),
                          )}
                        </article>
                      ))}
                    {w.members
                      .filter((m) => includes(m.label, m.role))
                      .map((m) => (
                        <article key={m.id}>
                          <div className="grow">
                            <strong>{m.label}</strong>
                            <small>{m.role}</small>
                          </div>
                          {m.active ? btn('Revoke', () => show('revoke', m.id)) : 'Revoked'}
                        </article>
                      ))}
                  </>
                )}
              </>
            )}
            {tab === 'Audit log' &&
              (w.events.length ? (
                w.events
                  .filter((x) => includes(x.action, x.subject))
                  .map((x, i) => (
                    <article key={i}>
                      <Activity size={18} />
                      <div className="grow">
                        <strong>{x.action}</strong>
                        <small>
                          {x.actor} · {x.subject}
                        </small>
                      </div>
                      <small>{stamp(x.at)}</small>
                    </article>
                  ))
              ) : (
                <div className="empty">
                  <Activity />
                  <h3>No activity yet</h3>
                  <p>Workspace events appear as you add connections and issue grants.</p>
                </div>
              ))}
          </section>
        </div>
      </main>
      <dialog ref={dialog} onCancel={close} aria-labelledby="dialog-title">
        <div className="dialogHead">
          <h2 id="dialog-title">
            {
              (
                {
                  item: 'Add vault item',
                  deleteItem: 'Delete vault item',
                  revealed: 'Vault item value',
                  app: 'Register identity application',
                  member: tokens ? 'Member access token' : 'Add workspace member',
                  oauth:
                    selected === 'notion'
                      ? 'Connect Notion with OAuth'
                      : 'Connect Google with OAuth',
                  connection: 'Add connection',
                  provider: w.providers[selected]?.name,
                  rotate: 'Rotate credential',
                  revoke: 'Revoke access',
                  grant: tokens ? 'Device credentials' : 'Issue access grant',
                  workspace: 'New workspace',
                } as Record<string, string>
              )[modal]
            }
          </h2>
          <button aria-label="Close dialog" onClick={close}>
            <X size={18} />
          </button>
        </div>
        {modal === 'provider' ? (
          <>
            <p>{w.providers[selected]?.group}</p>
            <ul>
              {w.providers[selected]?.actions.map((a) => (
                <li key={a.id}>
                  <code>{a.id}</code>
                  <small>{a.method === 'GET' ? 'Read' : 'Approval required'}</small>
                </li>
              ))}
            </ul>
            {w.role !== 'viewer' && (
              <button className="primary" onClick={() => M('connection')}>
                Connect account <ArrowUpRight size={16} />
              </button>
            )}
          </>
        ) : tokens ? (
          <>
            <p>
              {modal === 'revealed'
                ? 'Close this dialog to hide the value.'
                : modal === 'member'
                  ? 'Give this token to the member through a private channel.'
                  : modal === 'app'
                    ? 'Copy the action-check credential now and provide it to the registered application.'
                    : 'Copy these credentials now. The access token expires in 15 minutes or when the grant ends.'}
            </p>
            <pre>{tokens}</pre>
            <button
              onClick={() =>
                work(async () => {
                  await navigator.clipboard.writeText(tokens)
                  CP(true)
                })
              }
            >
              {copied ? <Check size={16} /> : <Copy size={16} />}{' '}
              {copied ? 'Copied' : 'Copy credentials'}
            </button>
          </>
        ) : (
          <form onSubmit={submit}>
            {modal === 'connection' && (
              <>
                <label>
                  Provider
                  <select value={selected} onChange={(e) => S(e.target.value)}>
                    {Object.entries(w.providers).map(([id, p]) => (
                      <option key={id} value={id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Connection name
                  <input name="label" required placeholder="Editorial account" />
                </label>
                <label>
                  Account identity
                  <input name="external_identity" required placeholder="team@example.com" />
                </label>
              </>
            )}
            {modal === 'connection' &&
              [
                'google_workspace',
                'google_sheets',
                'supabase_data',
                'revolut',
                'loops',
                'hubspot',
              ].includes(selected) && (
                <label>
                  {selected === 'google_workspace'
                    ? 'Authorized Gmail label IDs'
                    : selected === 'google_sheets'
                      ? 'Authorized spreadsheet IDs'
                      : selected === 'revolut'
                        ? 'Authorized Revolut account IDs'
                        : selected === 'hubspot'
                          ? 'Authorized template directories (end each with /)'
                          : selected === 'loops'
                            ? 'Authorized Loops list IDs'
                            : 'Authorized database tables'}{' '}
                  (comma-separated)
                  <input name="resources" placeholder="INBOX, Label_123" />
                </label>
              )}
            {modal === 'connection' &&
              selected === 'google_workspace' &&
              btn('Sign in with Google instead', () => M('oauth'))}
            {modal === 'connection' &&
              selected === 'notion' &&
              btn('Authorize with Notion', () => M('oauth'))}
            {modal === 'oauth' && (
              <>
                <p>Register this redirect URI in your OAuth client settings.</p>
                <code>
                  {location.origin}/api/oauth/{selected === 'notion' ? 'notion' : 'google'}/callback
                </code>
                <label>
                  Connection name
                  <input name="label" required />
                </label>
                <label>
                  Client ID
                  <input name="client_id" required />
                </label>
                <label>
                  Client secret
                  <input name="client_secret" type="password" required />
                </label>
                {selected !== 'notion' && (
                  <>
                    <label>
                      Authorized Gmail label IDs (optional)
                      <input name="resources" />
                    </label>
                    <label>
                      Access scope
                      <select name="scope">
                        {[
                          'drive.readonly',
                          'drive.file',
                          'documents',
                          'presentations',
                          'calendar.events',
                          'gmail.readonly',
                          'spreadsheets',
                          'calendar.readonly',
                          'youtube.readonly',
                          'youtube.upload',
                        ].map((v) => (
                          <option key={v} value={'https://www.googleapis.com/auth/' + v}>
                            {v}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                )}
              </>
            )}
            {['connection', 'rotate'].includes(modal) && (
              <label>
                {selected === 'supabase_data'
                  ? 'Credential JSON with project and key'
                  : selected === 'twilio'
                    ? 'Account SID and auth token (SID:token)'
                    : 'Provider credential'}
                <input type="password" autoComplete="new-password" name="secret" required />
              </label>
            )}
            {modal === 'revoke' && (
              <p>
                Revoke access for{' '}
                <strong>
                  {w.connections.find((c) => c.id === selected)?.label ||
                    w.grants.find((g) => g.id === selected)?.label ||
                    w.members.find((m) => m.id === selected)?.label}
                </strong>
                ? New calls using this access will be refused.
              </p>
            )}
            {modal === 'deleteItem' && (
              <p>Delete {w.items.find((i) => i.id === selected)?.title} from this workspace?</p>
            )}
            {modal === 'item' && (
              <>
                <label>
                  Item title
                  <input name="title" required />
                </label>
                <label>
                  Username (optional)
                  <input name="username" />
                </label>
                <label>
                  Password or secure note
                  <textarea name="value" required />
                </label>
              </>
            )}
            {modal === 'app' && (
              <>
                <label>
                  Application name
                  <input name="label" required />
                </label>
                <label>
                  HTTPS callback URL
                  <input name="callback" type="url" required />
                </label>
                <label>
                  Audience
                  <input name="audience" required placeholder="app.example.com" />
                </label>
                <label>
                  Registration duration (days)
                  <input name="days" type="number" min="1" max="365" defaultValue="30" required />
                </label>
              </>
            )}
            {modal === 'app' && (
              <fieldset>
                <legend>Delegated actions (optional)</legend>
                {['conversation.read', 'conversation.write', 'attention.write'].map((c) => (
                  <label key={c}>
                    <input type="checkbox" name="classes" value={c} />
                    {c}
                  </label>
                ))}
                <label>
                  <input type="checkbox" name="member_write_allowed" />
                  Allow editors to consent to write actions
                </label>
              </fieldset>
            )}
            {modal === 'member' && (
              <>
                <label>
                  Member name
                  <input name="label" required />
                </label>
                <label>
                  Role
                  <select name="role">
                    <option value="viewer">Viewer</option>
                    <option value="editor">Editor</option>
                  </select>
                </label>
              </>
            )}
            {modal === 'workspace' && (
              <label>
                Workspace name
                <input name="label" required />
              </label>
            )}
            {modal === 'grant' && (
              <>
                <label>
                  Device name
                  <input name="label" required />
                </label>
                <label>
                  Connection
                  <select
                    value={grantId}
                    onChange={(e) => {
                      G(e.target.value)
                      C([])
                    }}
                  >
                    {active.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </label>
                <fieldset>
                  <legend>Allowed operations</legend>
                  {selectedConnection &&
                    w.providers[selectedConnection.provider].actions.map((a) => (
                      <label className="check" key={a.id}>
                        <input
                          type="checkbox"
                          checked={checked.includes(a.id)}
                          onChange={(e) =>
                            C(
                              e.target.checked
                                ? [...checked, a.id]
                                : checked.filter((x) => x !== a.id),
                            )
                          }
                        />
                        {a.id}
                      </label>
                    ))}
                </fieldset>
                {w.role === 'owner' &&
                  checked.some((op) =>
                    [
                      'loops.newsletter.create_campaign',
                      'hubspot.newsletter.update_draft',
                    ].includes(op),
                  ) && (
                    <label>
                      Preapproved unsent drafts per UTC day (optional)
                      <input name="draft_limit" type="number" min="1" max="100" />
                    </label>
                  )}
                <label>
                  Grant duration (hours)
                  <input type="number" min="1" max="720" defaultValue="24" name="hours" required />
                </label>{' '}
                {!!selectedConnection &&
                  checked.includes(selectedConnection.provider + '.chat') && (
                    <fieldset>
                      <legend>Standing model access (optional)</legend>
                      <label>
                        Authorized model
                        <input name="model" placeholder="Exact provider model ID" />
                      </label>
                      <label>
                        Maximum requests
                        <input name="calls" type="number" min="1" max="10000" defaultValue="10" />
                      </label>
                      <label>
                        Maximum output tokens per request
                        <input
                          name="max_tokens"
                          type="number"
                          min="1"
                          max="32768"
                          defaultValue="1024"
                        />
                      </label>
                      <details>
                        <summary>Monetary budget (optional)</summary>
                        <label>
                          Budget in micro-USD
                          <input name="budget" type="number" min="1" />
                        </label>
                        <label>
                          Input micro-USD per million tokens
                          <input name="input_rate" type="number" min="0" />
                        </label>
                        <label>
                          Output micro-USD per million tokens
                          <input name="output_rate" type="number" min="0" />
                        </label>
                        <label>
                          Pricing source
                          <input name="price_source" type="url" />
                        </label>
                        <label>
                          Pricing date
                          <input name="price_date" type="date" />
                        </label>
                      </details>
                    </fieldset>
                  )}
                <label>
                  Pairing code (optional)
                  <input name="user_code" />
                </label>
              </>
            )}
            {error}
            <button className="primary" disabled={busy || (modal === 'grant' && !checked.length)}>
              {
                (
                  {
                    item: 'Save item',
                    deleteItem: 'Delete item',
                    app: 'Register application',
                    member: 'Create member token',
                    oauth: selected === 'notion' ? 'Continue to Notion' : 'Continue to Google',
                    connection: 'Save connection',
                    rotate: 'Rotate credential',
                    grant: 'Issue grant',
                    revoke: 'Revoke access',
                    workspace: 'Create workspace',
                  } as Record<string, string>
                )[modal]
              }
            </button>
          </form>
        )}
      </dialog>
    </div>
  )
}
