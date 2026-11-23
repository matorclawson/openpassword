'use client'
import { useEffect, useState } from 'react'

type Event = { id: number; action: string; actor: string; subject: string; at: number }
export function ActivityFeed({ query }: { query: string }) {
  const [events, setEvents] = useState<Event[]>([])
  const [status, setStatus] = useState('Connecting…')
  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    let retry: ReturnType<typeof setTimeout>
    async function watch() {
      let cursor: number | undefined
      let delay = 500
      while (!signal.aborted) {
        try {
          const response = await fetch(
            '/api/admin/activity' + (cursor === undefined ? '' : '?after=' + cursor),
            { cache: 'no-store', signal },
          )
          if (response.status === 401 || response.status === 409) {
            location.reload()
            return
          }
          if (!response.ok) throw Error()
          const page = await response.json()
          if (signal.aborted) return
          cursor = page.cursor
          const rows: Event[] = page.events.reverse()
          if (rows.length) setEvents((previous) => [...rows, ...previous].slice(0, 100))
          setStatus('Live')
          delay = 500
        } catch {
          if (signal.aborted) return
          setStatus('Reconnecting…')
          await new Promise<void>((resolve) => {
            retry = setTimeout(resolve, delay + Math.random() * 250)
          })
          delay = Math.min(delay * 2, 10000)
        }
      }
    }
    void watch()
    return () => {
      controller.abort()
      clearTimeout(retry)
    }
  }, [])
  const visible = events.filter((e) =>
    [e.action, e.actor, e.subject].join(' ').toLowerCase().includes(query.toLowerCase()),
  )
  return (
    <>
      <small role="status">{status}</small>
      {visible.map((e) => (
        <article key={e.id}>
          <div className="grow">
            <strong>{e.action}</strong>
            <small>
              {e.actor} · {e.subject}
            </small>
          </div>
          <time dateTime={new Date(e.at).toISOString()}>{new Date(e.at).toLocaleString()}</time>
        </article>
      ))}
      {!visible.length && <p>{query ? 'No matching events.' : 'Waiting for activity.'}</p>}
    </>
  )
}
