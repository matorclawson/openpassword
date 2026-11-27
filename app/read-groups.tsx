'use client'
import { useState } from 'react'
import { decryptPrivate, encryptPrivate } from './private-crypto'
import { fingerprint, sealCopy } from './read-share-crypto'
type Card = { tenant: string; profile: string; fingerprint: string }
type Group = { id: string; version: number; name: string; cards: Card[] }
type Props = {
  api: (p: string, b?: unknown, m?: string) => Promise<any>
  vault: CryptoKey
  tenant: string
  profile: string
  item?: { id: string; revision: number; title: string }
  secret: () => Promise<string>
}
export function ReadGroups({ api, vault, tenant, profile, item, secret }: Props) {
  const root = 'profile/vault/read/groups',
    ctx = (id: string, v: number) =>
      JSON.stringify(['OpenPassword.read-group.v1', tenant, profile, id, v])
  const [groups, G] = useState<Group[]>([]),
    [selected, S] = useState(''),
    [status, M] = useState(''),
    [busy, B] = useState(false)
  const group = groups.find((g) => g.id === selected)
  async function load() {
    const rows = await api(root)
    G(
      await Promise.all(
        rows.map(async (r: { id: string; version: number; description: string }) => ({
          ...JSON.parse(await decryptPrivate(vault, ctx(r.id, r.version), r.description)),
          id: r.id,
          version: r.version,
        })),
      ),
    )
  }
  async function run(fn: () => Promise<void>) {
    B(true)
    M('')
    try {
      await fn()
    } catch {
      M(
        'Group access changed or a recipient card did not match. Reload the groups and verify the cards.',
      )
    } finally {
      B(false)
    }
  }
  async function resolve(c: Card) {
    if (c.tenant !== tenant || c.profile === profile) throw Error()
    const { pub } = await api('profile/vault/read/recipient/' + encodeURIComponent(c.profile))
    if ((await fingerprint(pub)) !== c.fingerprint) throw Error()
    return pub
  }
  return (
    <details>
      <summary>Read groups</summary>
      <p>
        Each member receives a readable copy. Updating a group ends future delivery of its previous
        shares. Share the current item again after editing the roster.
      </p>
      <button disabled={busy} onClick={() => run(load)}>
        Load my groups
      </button>
      <label>
        Read group
        <select value={selected} onChange={(e) => S(e.target.value)}>
          <option value="">New group</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      </label>
      <form
        key={group?.id || 'new'}
        onSubmit={(e) => {
          e.preventDefault()
          const f = new FormData(e.currentTarget)
          void run(async () => {
            const name = String(f.get('name')).trim(),
              cards = String(f.get('cards'))
                .trim()
                .split(/\n+/)
                .map((line) => JSON.parse(line) as Card)
            if (
              !name ||
              cards.length > 16 ||
              new Set(cards.map((c) => c.profile)).size !== cards.length
            )
              throw Error()
            await Promise.all(cards.map(resolve))
            const id = group?.id || crypto.randomUUID(),
              version = group?.version || 0
            await api(root, {
              id,
              version,
              roster: cards.map((c) => c.profile),
              description: await encryptPrivate(
                vault,
                ctx(id, version + 1),
                JSON.stringify({ name, cards }),
              ),
            })
            await load()
            S(id)
            M('Group saved.')
          })
        }}
      >
        <label>
          Group name
          <input name="name" required maxLength={100} defaultValue={group?.name} />
        </label>
        <label>
          Verified recipient cards, one per line
          <textarea
            required
            name="cards"
            defaultValue={group?.cards.map((c) => JSON.stringify(c)).join('\n')}
          />
        </label>
        <button disabled={busy}>Save read group</button>
      </form>
      {group && item && (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            const f = new FormData(e.currentTarget)
            void run(async () => {
              const expires = Date.now() + Number(f.get('days')) * 86400000,
                value = await secret()
              const copies = await Promise.all(
                group.cards.map(async (c) => {
                  const pub = await resolve(c),
                    b = {
                      id: crypto.randomUUID(),
                      owner: profile,
                      tenant,
                      recipient: c.profile,
                      item: item.id,
                      revision: item.revision,
                      expires,
                    }
                  return {
                    id: b.id,
                    recipient: c.profile,
                    item: item.id,
                    revision: item.revision,
                    expires,
                    pub,
                    ...(await sealCopy(pub, c.fingerprint, b, item.title, value)),
                  }
                }),
              )
              await api(root + '/' + group.id + '/share', { version: group.version, copies })
              M('Read access granted to every group member.')
            })
          }}
        >
          <label>
            Days of group access
            <input type="number" name="days" min="1" max="365" defaultValue="7" required />
          </label>
          <button disabled={busy}>
            Share {item.title} with {group.name}
          </button>
        </form>
      )}
      {group && (
        <button
          disabled={busy}
          onClick={() =>
            run(async () => {
              await api(root + '/' + group.id, undefined, 'DELETE')
              S('')
              await load()
              M('Group removed and future delivery revoked.')
            })
          }
        >
          Remove group and revoke its shares
        </button>
      )}
      {status && <p role="status">{status}</p>}
    </details>
  )
}
