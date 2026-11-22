import { setTimeout as delay } from 'node:timers/promises'
/** One broker-wide dispatch schedule per connection, across batch and ordinary requests. */
export function loopsPacer(send: typeof fetch) {
  const clocks = new Map<string, number>()
  return async (
    connection: string,
    url: string | URL,
    init: RequestInit,
    deadline: number,
    authorize: () => void,
  ) => {
    for (;;) {
      const now = Date.now(),
        next = clocks.get(connection) ?? 0
      if (Math.max(now, next) >= deadline) throw Error('rate_exhausted')
      if (next > now) {
        await delay(next - now)
        continue
      }
      authorize()
      clocks.set(connection, now + 125)
      const signal = AbortSignal.timeout(Math.max(1, deadline - now))
      const response = await send(url, {
        ...init,
        signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal,
      })
      if (response.status !== 429) return response
      await response.body?.cancel()
      const value = response.headers.get('retry-after')?.trim()
      const wait =
        value && /^\d+(\.\d+)?$/.test(value)
          ? Number(value) * 1000
          : value && Number.isFinite(Date.parse(value))
            ? Date.parse(value) - Date.now()
            : 1000
      clocks.set(
        connection,
        Math.max(clocks.get(connection) ?? 0, Date.now() + Math.min(120000, Math.max(0, wait))),
      )
    }
  }
}
