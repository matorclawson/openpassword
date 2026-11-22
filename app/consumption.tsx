'use client'
import { useState, useEffect } from 'react'
type Group = {
  id: string
  conn: string
  label: string
  provider: string
  requests: number
  priced_micro_usd: number
  priced_requests: number
  pending_micro_usd: number
  input_tokens: number | null
  output_tokens: number | null
}
type Event = {
  id: number
  started: number
  agent_label: string
  label: string
  operation: string
  model: string | null
  outcome: string
  status: number | null
  cost_micro_usd: number | null
}
type Report = { groups: Group[]; events: Event[]; next: number | null }
const usd = (n: number) =>
  '$' +
  (n / 1000000).toLocaleString(undefined, { maximumFractionDigits: 6, minimumFractionDigits: 2 })
export function Consumption({ request }: { request: (path: string) => Promise<Report> }) {
  const [days, D] = useState(7),
    [group, setGroup] = useState('credential'),
    [page, P] = useState<number>(),
    [refresh, R] = useState(0),
    [report, S] = useState<Report>(),
    [error, E] = useState('')
  useEffect(() => {
    let live = true
    S(undefined)
    E('')
    request('admin/consumption?days=' + days + '&group=' + group + (page ? '&before=' + page : ''))
      .then((r) => {
        if (live) S(r)
      })
      .catch((e) => {
        if (live) E(e.message)
      })
    return () => {
      live = false
    }
  }, [days, group, page, refresh, request])
  return (
    <section className="authentication">
      <label>
        Period{' '}
        <select
          value={days}
          onChange={(e) => {
            P(undefined)
            D(Number(e.target.value))
          }}
        >
          <option value={1}>Last 24 hours</option>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={0}>All history</option>
        </select>
      </label>{' '}
      <label>
        Group by{' '}
        <select
          value={group}
          onChange={(e) => {
            P(undefined)
            setGroup(e.target.value)
          }}
        >
          <option value="credential">Credential</option>
          <option value="agent">Agent grant</option>
        </select>
      </label>
      <button
        onClick={() => {
          P(undefined)
          R(refresh + 1)
        }}
      >
        Refresh usage
      </button>
      {error && <p role="alert">{error}</p>}
      {report && (
        <>
          {report.groups.length === 0 ? (
            <p>No brokered API requests in this period.</p>
          ) : (
            <>
              <h2>Estimated spend</h2>
              <p>
                {report.groups.some((g) => g.priced_requests)
                  ? usd(report.groups.reduce((sum, g) => sum + g.priced_micro_usd, 0))
                  : 'No priced requests'}{' '}
                · {report.groups.reduce((sum, g) => sum + g.requests - g.priced_requests, 0)}{' '}
                requests without a settled cost
              </p>
              <h2>Usage by {group === 'agent' ? 'agent grant' : 'credential'}</h2>
              {report.groups.map((g) => (
                <article key={g.id}>
                  <div className="grow">
                    <strong>
                      {g.label} · {g.provider}
                    </strong>
                    <small>
                      {g.requests} upstream requests · {g.requests - g.priced_requests} without a
                      settled cost
                    </small>
                    <small>
                      {g.input_tokens ?? '—'} input tokens · {g.output_tokens ?? '—'} output tokens
                    </small>
                  </div>
                  <div>
                    {g.priced_requests ? usd(g.priced_micro_usd) : 'Unpriced'}
                    <small>
                      {g.pending_micro_usd ? usd(g.pending_micro_usd) + ' reserved' : ''}
                    </small>
                  </div>
                </article>
              ))}
              <h2>Request history</h2>
              {report.events.map((e) => (
                <article key={e.id}>
                  <div className="grow">
                    <strong>
                      {e.agent_label} · {e.label}
                    </strong>
                    <small>
                      {new Date(e.started).toLocaleString()} · {e.operation}
                      {e.model && ' · ' + e.model}
                    </small>
                    <small>
                      {e.outcome.replaceAll('_', ' ')} {e.status ?? ''}
                    </small>
                  </div>
                  {e.cost_micro_usd === null ? 'Unpriced' : usd(e.cost_micro_usd)}
                </article>
              ))}
              {page && <button onClick={() => P(undefined)}>Most recent</button>}{' '}
              {report.next && <button onClick={() => P(report.next!)}>Older requests</button>}
            </>
          )}
        </>
      )}
    </section>
  )
}
