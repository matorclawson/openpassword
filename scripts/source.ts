// Produce the corresponding source download from the release tree on Linux.
import { execFileSync } from 'node:child_process'
import { readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
const inputs = [
  'README.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'PARITY.md',
  'Makefile',
  'LICENSE',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'next-env.d.ts',
  'next.config.ts',
  'postcss.config.mjs',
  '.gitignore',
  '.prettierrc.json',
]
function collect(dir: string) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!['dist', 'node_modules'].includes(entry.name)) collect(path)
    } else if (
      entry.isFile() &&
      (/\.(ts|tsx|css|json|woff2|txt|md|service)$/.test(entry.name) || entry.name === 'LICENSE')
    )
      inputs.push(path)
  }
}
for (const dir of [
  'app',
  'server',
  'packages',
  'scripts',
  'tests',
  'examples',
  'deploy',
  'docs',
  'public/fonts',
])
  collect(dir)
const tmp = 'public/openpassword-source.tar.gz.tmp'
execFileSync('tar', ['-czf', tmp, '--', ...inputs.sort()])
renameSync(tmp, 'public/openpassword-source.tar.gz')
