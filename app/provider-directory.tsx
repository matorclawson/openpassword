import { ArrowUpRight, Blocks } from 'lucide-react'
import type { Provider } from '../packages/connectors'

export function ProviderDirectory({
  providers,
  query,
  open,
}: {
  providers: Record<string, Provider>
  query: string
  open: (id: string) => void
}) {
  const groups = new Map<string, [string, Provider][]>()
  for (const entry of Object.entries(providers)) {
    const [, p] = entry
    if (
      ![p.name, p.group, ...p.actions.map((action) => action.id)]
        .join(' ')
        .toLowerCase()
        .includes(query.trim().toLowerCase())
    )
      continue
    if (!groups.has(p.group)) groups.set(p.group, [])
    groups.get(p.group)!.push(entry)
  }
  if (!groups.size)
    return (
      <div className="empty">
        <Blocks />
        <h3>No matching integrations</h3>
        <p>Try a provider name or operation.</p>
      </div>
    )
  return (
    <div className="providerIndex">
      {[...groups]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([group, entries]) => (
          <section className="providerGroup" key={group}>
            <h3>{group}</h3>
            <div>
              {entries
                .sort(([, a], [, b]) => a.name.localeCompare(b.name))
                .map(([id, p]) => (
                  <button key={id} onClick={() => open(id)}>
                    <strong>{p.name}</strong>
                    <span>
                      {p.actions.length} {p.actions.length === 1 ? 'operation' : 'operations'}
                    </span>
                    <ArrowUpRight size={15} />
                  </button>
                ))}
            </div>
          </section>
        ))}
    </div>
  )
}
