// Produce the corresponding source download from the release tree on Linux.
import { execFileSync } from 'node:child_process'
import { readdirSync, renameSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
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
      (/\.(ts|tsx|css|json|woff2|txt|md|service|sh)$/.test(entry.name) || entry.name === 'LICENSE')
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
  'registry',
  'public/fonts',
])
  collect(dir)
const tmp = 'public/openpassword-source.tar.gz.tmp'
// Reproducible metadata: fixed mtime, sorted names, numeric owner 0:0, no gzip timestamp.
// GNU tar is used when present; BSD tar (local macOS development) writes a plain archive.
const gnu = execFileSync('tar', ['--version']).toString().includes('GNU tar')
let epoch = process.env.SOURCE_DATE_EPOCH
if (!epoch) {
  try {
    epoch = execFileSync('git', ['log', '-1', '--format=%ct']).toString().trim()
  } catch {
    epoch = '0'
  }
}
const flags = gnu
  ? ['--sort=name', '--mtime=@' + epoch, '--owner=0', '--group=0', '--numeric-owner', '--format=gnu']
  : []
const archive = execFileSync('tar', ['-cf', '-', ...flags, '--', ...inputs.sort()], {
  maxBuffer: 1 << 30,
})
writeFileSync(tmp, gzipSync(archive, { level: 9 }))
renameSync(tmp, 'public/openpassword-source.tar.gz')
