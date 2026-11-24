'use client'
import { useEffect, useState } from 'react'
type Source = { id: string; title: string }
export function ItemPicker({
  request,
  selected,
  select,
}: {
  request: (path: string) => Promise<{ rows: (Source & { username: string })[]; total: number }>
  selected: Source | null
  select: (item: Source | null) => void
}) {
  const [expanded, setExpanded] = useState(false),
    [query, setQuery] = useState(''),
    [page, setPage] = useState(1),
    [result, setResult] = useState<Awaited<ReturnType<typeof request>>>(),
    [error, setError] = useState('')
  useEffect(() => {
    if (!expanded) return
    let current = true
    setResult(undefined)
    setError('')
    const timer = setTimeout(
      () =>
        request('admin/items?q=' + encodeURIComponent(query) + '&page=' + page)
          .then((r) => {
            if (current) setResult(r)
          })
          .catch((e) => {
            if (current) setError(e.message)
          }),
      100,
    )
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [expanded, query, page, request])
  return (
    <section className="itemPicker">
      <strong>Credential source</strong>
      {selected ? (
        <>
          <p>Vault item · {selected.title}</p>
          <button type="button" onClick={() => select(null)}>
            Use a new credential instead
          </button>
        </>
      ) : (
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Close vault picker' : 'Choose a saved vault item'}
        </button>
      )}
      {expanded && !selected && (
        <>
          <label>
            Find a vault item
            <input
              maxLength={256}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setPage(1)
              }}
            />
          </label>
          {error ? (
            <p role="alert">{error}</p>
          ) : !result ? (
            <p>Loading items…</p>
          ) : (
            <>
              {result.rows.map((i) => (
                <button
                  key={i.id}
                  type="button"
                  onClick={() => {
                    select(i)
                    setExpanded(false)
                  }}
                >
                  {i.title} {i.username}
                </button>
              ))}
              {!result.total && <p>No matching items.</p>}
              {page > 1 && (
                <button type="button" onClick={() => setPage(page - 1)}>
                  Previous items
                </button>
              )}
              {page * 30 < result.total && (
                <button type="button" onClick={() => setPage(page + 1)}>
                  More items
                </button>
              )}
            </>
          )}
        </>
      )}
    </section>
  )
}
