// The standalone CLI bundle gets the release version baked in (scripts/client.ts defines
// OPENPASSWORD_VERSION from the root package.json). A native install or an unbundled run falls back to
// this package's own version, which is versioned separately from the release.
import { readFileSync } from 'node:fs'
declare const OPENPASSWORD_VERSION: string | undefined
function packageVersion() {
  try {
    return String(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version)
  } catch {
    return 'dev'
  }
}
export const version = typeof OPENPASSWORD_VERSION === 'string' ? OPENPASSWORD_VERSION : packageVersion()
