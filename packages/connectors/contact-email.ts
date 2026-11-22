export function checkContactEmail(value: unknown) {
  if (typeof value !== 'string') return 'shape'
  if (value.normalize('NFC') !== value) return 'not_nfc'
  if (/[^\x20-\x7e]/.test(value)) return 'not_ascii_printable'
  if (value.trim() !== value) return 'whitespace'
  if (value.toLowerCase() !== value) return 'not_lowercase'
  const parts = value.split('@')
  if (parts.length !== 2 || value.length > 254) return 'shape'
  const [local, domain] = parts
  if (!/^[a-z0-9.!#$%&'*+/=?^_\x60{|}~-]{1,64}$/.test(local)) return 'local_part'
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return 'local_dots'
  const labels = domain.split('.')
  if (labels.length < 2 || labels.some((s) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(s)))
    return 'domain'
  return /^[a-z]{2,}$/.test(labels.at(-1)!) ? 'ok' : 'tld'
}
