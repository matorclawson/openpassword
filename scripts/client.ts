// A remote client needs Node, this file, and the broker's URL.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
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

const bundle = readFileSync('public/openpassword-cli.cjs')
writeFileSync(
  'public/openpassword-cli.sha256',
  createHash('sha256').update(bundle).digest('hex') + '\n',
)
copyFileSync('deploy/update-client.sh', 'public/update-client.sh')
