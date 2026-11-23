// A remote client needs Node, this file, and the broker's URL.
import { build } from 'esbuild'
import { resolve } from 'node:path'
await build({
  entryPoints: ['packages/cli/index.ts'],
  outfile: 'public/openpassword-cli.cjs',
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  bundle: true,
  alias: { '@openpassword/client': resolve('packages/client/index.ts') },
  legalComments: 'eof',
})
