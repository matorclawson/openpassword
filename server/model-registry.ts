// Vendor registry (openpassword-SOW-03 section 1). One JSON file per vendor under registry/vendors,
// validated here. Code grows with protocol families, not with vendors: a plain vendor is data.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { PolicyError, policyId, type ResolvedModel } from './model-policy.ts'
import { CLONING, type ClassifiedOperation } from './voice-policy.ts'

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
const header = z.string().regex(/^[A-Za-z0-9-]{1,64}$/)
const family = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/)

export const modelEntry = z
  .object({
    id: z.string().min(1).max(200),
    modality: z
      .enum(['chat', 'embeddings', 'images', 'speech', 'transcription', 'realtime'])
      .default('chat'),
    family: family.optional(),
    aliases: z.array(z.string().min(1).max(200)).max(64).default([]),
    status: z.enum(['active', 'deprecated', 'removed']).default('active'),
    shutdown_on: z.iso.date().optional(),
  })
  .strict()

// Template fields in a base URL are validated by a fixed vocabulary, so a value can never add a
// host, a port, a path or userinfo.
const fieldRule = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('slug'), max: z.number().int().min(1).max(64).default(64) }).strict(),
  z.object({ kind: z.literal('enum'), values: z.array(z.string().regex(/^[a-z0-9-]{1,32}$/)).min(1) }).strict(),
])

const endpoint = z
  .object({
    family: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/),
    base_url: z.string().min(9).max(300),
    path: z.string().regex(/^\/[A-Za-z0-9/_:.-]{0,120}$/),
    headers: z.record(header, z.string().max(200)).default({}),
    max_tokens_param: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
    /** Voice cloning, conversion or design. Required on every endpoint of a voice vendor. */
    cloning: z.boolean().optional(),
  })
  .strict()

export const descriptor = z
  .object({
    id: slug,
    name: z.string().min(1).max(80),
    category: z.enum(['lab', 'hoster', 'gateway', 'hyperscaler', 'enterprise', 'voice']),
    status: z.enum(['candidate', 'verified', 'supported', 'deprecated', 'removed']),
    substitution: z.enum(['none-documented', 'owner-defined', 'possible', 'unknown']),
    auth: z
      .object({ kind: z.enum(['bearer', 'header']), header: header.optional(), prefix: z.string().max(20).optional() })
      .strict(),
    fields: z.record(z.string().regex(/^[a-z_]{1,32}$/), fieldRule).default({}),
    endpoints: z.record(z.string().regex(/^[a-z.]{1,40}$/), endpoint).refine((e) => Object.keys(e).length > 0),
    models_path: z.string().regex(/^\/[A-Za-z0-9/_.-]{0,80}$/).optional(),
    ids_case_insensitive: z.boolean().default(false),
    consent_mechanism: z.boolean().default(false),
    models: z.array(modelEntry).default([]),
    verified_on: z.iso.date().optional(),
    doc_url: z.url({ protocol: /^https$/ }),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (d.auth.kind === 'header' && !d.auth.header)
      ctx.addIssue({ code: 'custom', message: 'header auth needs a header name' })
    for (const [name, e] of Object.entries(d.endpoints)) {
      // Consent is keyed on this explicit field, not on a naming convention: a voice vendor must classify
      // every endpoint, and a cloning-looking name can never be classified as standard.
      if (d.category === 'voice' && e.cloning === undefined)
        ctx.addIssue({ code: 'custom', message: name + ': a voice endpoint must declare cloning true or false' })
      if (CLONING.test(name) && e.cloning !== true)
        ctx.addIssue({ code: 'custom', message: name + ': a cloning endpoint must declare cloning true' })
      if (/(^|\.)voice(\.|$)/.test(name) && e.cloning === undefined)
        ctx.addIssue({ code: 'custom', message: name + ': a voice endpoint must declare cloning true or false' })
      if (!e.base_url.startsWith('https://'))
        ctx.addIssue({ code: 'custom', message: name + ': base_url must be https' })
      const used = new Set([...e.base_url.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]))
      for (const u of used)
        if (!d.fields[u]) ctx.addIssue({ code: 'custom', message: name + ': undeclared field ' + u })
      const rest = e.base_url.replace(/\{[a-z_]+\}/g, 'x')
      try {
        const u = new URL(rest)
        if (u.username || u.password || u.port || u.search || u.hash)
          ctx.addIssue({ code: 'custom', message: name + ': base_url has userinfo, port, query or fragment' })
      } catch {
        ctx.addIssue({ code: 'custom', message: name + ': base_url is not a URL' })
      }
    }
  })
export type Descriptor = z.infer<typeof descriptor>
export type ModelEntry = z.infer<typeof modelEntry>

/** Expand a base URL template. Every value must satisfy its declared field rule. */
export function expandBaseUrl(d: Descriptor, endpointName: string, values: Record<string, string> = {}) {
  const e = d.endpoints[endpointName]
  if (!e) throw new PolicyError('unknown_endpoint')
  const url = e.base_url.replace(/\{([a-z_]+)\}/g, (_, name: string) => {
    const rule = d.fields[name]
    const v = values[name]
    if (!rule || typeof v !== 'string') throw new PolicyError('bad_field')
    if (rule.kind === 'slug') {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(v) || v.length > rule.max) throw new PolicyError('bad_field')
    } else if (!rule.values.includes(v)) throw new PolicyError('bad_field')
    return v
  })
  const u = new URL(url)
  if (u.protocol !== 'https:' || u.username || u.password || u.port) throw new PolicyError('bad_base_url')
  return url.replace(/\/$/, '')
}

export interface Catalogue {
  vendors: Map<string, Descriptor>
}

export function buildCatalogue(list: Descriptor[]): Catalogue {
  const vendors = new Map<string, Descriptor>()
  for (const d of list) {
    if (vendors.has(d.id)) throw new Error('duplicate vendor ' + d.id)
    const seen = new Map<string, string>()
    for (const m of d.models) {
      for (const name of [m.id, ...m.aliases]) {
        const key = d.ids_case_insensitive ? name.toLowerCase() : name
        const prior = seen.get(key)
        if (prior !== undefined && prior !== m.id) throw new Error(d.id + ': ' + name + ' names two models')
        seen.set(key, m.id)
      }
    }
    vendors.set(d.id, d)
  }
  return { vendors }
}

export function loadRegistry(dir: string): Catalogue {
  const list: Descriptor[] = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const d = descriptor.parse(JSON.parse(readFileSync(join(dir, file), 'utf8')))
    if (file !== d.id + '.json') throw new Error(file + ' must be named ' + d.id + '.json')
    list.push(d)
  }
  return buildCatalogue(list)
}

/** The classification of one endpoint for the consent gate. An unclassified voice endpoint is refused. */
export function classifyOperation(d: Descriptor, endpointName: string): ClassifiedOperation {
  const e = d.endpoints[endpointName]
  if (!e) throw new PolicyError('unknown_endpoint')
  if (typeof e.cloning !== 'boolean') {
    if (d.category === 'voice') throw new PolicyError('unclassified_operation')
    return { name: d.id + '.' + endpointName, cloning: false }
  }
  return { name: d.id + '.' + endpointName, cloning: e.cloning }
}

/** Only verified and supported vendors may serve traffic; candidates are listed, never routed. */
export const servable = (d: Descriptor) => d.status === 'verified' || d.status === 'supported'

function lookup(d: Descriptor, id: string): ModelEntry | undefined {
  const fold = d.ids_case_insensitive
  const key = fold ? id.toLowerCase() : id
  return d.models.find((m) =>
    [m.id, ...m.aliases].some((n) => (fold ? n.toLowerCase() : n) === key),
  )
}

/**
 * Resolve the id a client sent. Aliases and dated snapshots resolve to one canonical entry. Family
 * comes only from the registry entry: a discovered or typed model is family `unknown`.
 */
export function resolveModel(cat: Catalogue, vendor: string, requestedId: string): ResolvedModel {
  const d = cat.vendors.get(vendor)
  if (!d) throw new PolicyError('unknown_vendor')
  policyId(vendor, requestedId)
  const entry = lookup(d, requestedId)
  return {
    vendor,
    requestedId,
    canonicalId: entry ? entry.id : requestedId,
    family: entry?.family ?? 'unknown',
  }
}

/** A model that is removed, or past its shutdown date, is refused. */
export function lifecycle(cat: Catalogue, vendor: string, id: string, now: Date) {
  const d = cat.vendors.get(vendor)
  if (!d) return { ok: false as const, code: 'unknown_vendor' }
  if (d.status === 'removed') return { ok: false as const, code: 'vendor_removed' }
  const e = lookup(d, id)
  if (!e) return { ok: true as const }
  if (e.status === 'removed') return { ok: false as const, code: 'model_retired' }
  if (e.shutdown_on && now.getTime() >= Date.parse(e.shutdown_on + 'T00:00:00Z'))
    return { ok: false as const, code: 'model_retired' }
  return { ok: true as const }
}

/**
 * Response identity check for guaranteed grants: the model the vendor reports must be the
 * requested canonical entry, one of its registered aliases or snapshots, or (deployment platforms)
 * in the owner-declared expected set. Anything else is a mismatch.
 */
export function reportedMatches(
  cat: Catalogue,
  requested: ResolvedModel,
  reported: unknown,
  ownerExpected: string[] = [],
): boolean {
  if (typeof reported !== 'string' || reported.length === 0) return false
  const d = cat.vendors.get(requested.vendor)
  if (!d) return false
  const fold = d.ids_case_insensitive
  const norm = (x: string) => (fold ? x.toLowerCase() : x)
  if (norm(reported) === norm(requested.canonicalId)) return true
  if (ownerExpected.some((x) => norm(x) === norm(reported))) return true
  const entry = lookup(d, reported)
  return !!entry && norm(entry.id) === norm(requested.canonicalId)
}
