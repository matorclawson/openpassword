import type { NextConfig } from 'next'
const config: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'http://127.0.0.1:' + (process.env.OPENPASSWORD_PORT || 4141) + '/:path*',
      },
      ...[
        '/delegate',
        '/delegate/confirm',
        '/delegate/exchange',
        '/.well-known/zeoconnect-delegation-keys.json',
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
