// The release version is baked in when the standalone CLI is bundled (scripts/client.ts defines
// OPENPASSWORD_VERSION from the root package.json). Run unbundled, it reports "dev".
declare const OPENPASSWORD_VERSION: string | undefined
export const version = typeof OPENPASSWORD_VERSION === 'string' ? OPENPASSWORD_VERSION : 'dev'
