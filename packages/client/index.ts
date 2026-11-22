export type DeviceTokens = {
  device_id: string
  access_token: string
  refresh_token: string
  access_expires_at: string
  refresh_expires_at: string
}
export type DevicePair = {
  device_code: string
  user_code: string
  verification_url: string
  interval_seconds: number
  expires_at: string
}
export class OpenPassword {
  readonly origin: string
  constructor(
    origin: string,
    private token?: string,
  ) {
    const u = new URL(origin)
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
    if (
      u.username ||
      u.password ||
      u.pathname !== '/' ||
      u.search ||
      u.hash ||
      !(u.protocol === 'https:' || (local && u.protocol === 'http:'))
    )
      throw Error('Use a secure broker origin')
    this.origin = u.origin
  }
  async request<T>(path: string, body?: unknown): Promise<T> {
    if (!path.startsWith('/v1/') || path.includes('..') || path.includes('\\'))
      throw Error('Invalid broker path')
    const r = await fetch(this.origin + path, {
      method: body ? 'POST' : 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(90000),
      headers: {
        'Content-Type': 'application/json',
        'ZEOconnect-Protocol-Version': '1',
        'ZEOconnect-Capabilities': 'expected-binding',
        ...(this.token ? { Authorization: 'Bearer ' + this.token } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (r.headers.get('zeoconnect-protocol-version') !== '1')
      throw Error('Broker protocol unavailable')
    if (!r.ok) throw Object.assign(Error('Broker returned ' + r.status), { status: r.status })
    return r.status === 204 ? (undefined as T) : ((await r.json()) as T)
  }
  pair(device_name: string) {
    return this.request<DevicePair>('/v1/device/authorizations', { device_name })
  }
  redeem(device_code: string) {
    return this.request<DeviceTokens>('/v1/device/token', { device_code })
  }
  refresh(refresh_token: string) {
    return this.request<DeviceTokens>('/v1/device/token/refresh', { refresh_token })
  }
  connections() {
    return this.request<unknown[]>('/v1/connections')
  }
  invoke(
    connection_id: string,
    operation_id: string,
    args: Record<string, unknown>,
    idempotency_key: string,
    expect?: { external_identity: string; connection_revision: string },
  ) {
    return this.request('/v1/operations/' + encodeURIComponent(operation_id) + ':invoke', {
      connection_id,
      operation_id,
      arguments: args,
      idempotency_key,
      ...(expect ? { expect } : {}),
    })
  }
}
