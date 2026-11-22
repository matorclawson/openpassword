import type { NextConfig } from 'next'
const config: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  async rewrites() {
    return [
      {
        source: '/v1/:path*',
        destination: 'http://127.0.0.1:' + (process.env.OPENPASSWORD_PORT || 4141) + '/v1/:path*',
      },
      {
        source: '/api/:path*',
        destination: 'http://127.0.0.1:' + (process.env.OPENPASSWORD_PORT || 4141) + '/:path*',
      },
      ...[
        '/hooks/:id',
        '/delegate',
        '/delegate/confirm',
        '/delegate/exchange',
        '/delegate/status',
        '/.well-known/openpassword-jwks.json',
        '/.well-known/openpassword-delegation-keys.json',
      ].map((source) => ({
        source,
        destination: 'http://127.0.0.1:' + (process.env.OPENPASSWORD_PORT || 4141) + source,
      })),
      ...['/device', '/approvals/:id'].map((source) => ({ source, destination: '/' })),
    ]
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
        ],
      },
    ]
  },
}
export default config
