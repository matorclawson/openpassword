// Model and voice policy engine (openpassword-SOW-03 section 2, SOW-04 section 2).
// Pure functions: no I/O, no clock, no database. Callers pass the resolved model, the rule lists
// and the connection's known facts; the engine returns a decision.
//
// Identity: a model is `<vendor>/<native_id>`. The vendor is a slug without `/`, so the first `/`
// splits it. The native id is kept byte for byte. Rules are glob patterns on that identifier, or
// `family:<name>`. Deny always wins. A model matching no allow rule is refused.
//
// Glob syntax: `*` matches any run of characters except `/`, `**` matches any run including `/`, and
// `?` matches exactly one character other than `/`. A pattern may hold at most 8 wildcard characters
// (`*` and `?` each count one, so `**` counts two), and a run of three or more `*` is refused.
//
// ID alphabet: model ids, voice ids and patterns use one alphabet, printable ASCII (U+0021..U+007E)
// without backslash and percent. Nothing else is admitted, so every character an id can hold is matched
// by `.`, `[^/]` and `?` alike and a wildcard cannot disagree with the validator.
//
// Rule data is validated once, before any matching (checkRule): `effect` is `allow` or `deny`;
// `max_tokens` and `calls` are positive safe integers; `expires` is a non-negative safe integer in one
// unit chosen by the caller and used for every rule of a decision (the engine only takes the minimum).
// An invalid rule throws PolicyError('bad_rule'); no decision is returned for it.

export type Effect = 'allow' | 'deny'
export interface Rule {
  effect: Effect
  model: string
  tariff?: string
  max_tokens?: number
  expires?: number
  calls?: number
}
export interface ResolvedModel {
  vendor: string
  /** The id the client asked for, validated. */
  requestedId: string
  /** The canonical native id after alias resolution (equal to requestedId when unknown). */
  canonicalId: string
  /** Assigned only by the registry. `unknown` for discovered or typed models. */
  family: string
}
export interface Caps {
  max_tokens?: number
  expires?: number
  calls?: number
}
export type Decision =
  | { ok: true; rule: Rule; caps: Caps; matched: Rule[] }
  | {
      ok: false
      code: 'model_not_permitted' | 'rule_ambiguous'
      rule?: Rule
      reason: string
    }
export class PolicyError extends Error {
  code: string
  constructor(code: string) {
    super(code)
    this.code = code
  }
}

const VENDOR = /^[a-z0-9][a-z0-9-]{0,62}$/
const FAMILY = /^[a-z0-9][a-z0-9._-]{0,62}$/
const ID_ALPHABET = /^[\u0021-\u007e]+$/
const BAD_CHARS = /[\\%]/
const MAX_WILDCARDS = 8

function checkNative(id: string, what: string) {
  if (typeof id !== 'string' || id.length < 1 || id.length > 200) throw new PolicyError(what)
  if (!ID_ALPHABET.test(id) || BAD_CHARS.test(id)) throw new PolicyError(what)
  for (const part of id.split('/')) if (part === '' || part === '.' || part === '..') throw new PolicyError(what)
}

export function policyId(vendor: string, nativeId: string): string {
  if (!VENDOR.test(vendor)) throw new PolicyError('bad_vendor')
  checkNative(nativeId, 'bad_model_id')
  return vendor + '/' + nativeId
}

type Pattern =
  | { kind: 'family'; name: string }
  | { kind: 'exact'; text: string }
  | { kind: 'glob'; text: string; literal: number; wildcards: number }

export function parsePattern(source: string): Pattern {
  if (typeof source !== 'string' || source.length < 1 || source.length > 200)
    throw new PolicyError('bad_pattern')
  if (!ID_ALPHABET.test(source) || BAD_CHARS.test(source)) throw new PolicyError('bad_pattern')
  if (source.startsWith('family:')) {
    const name = source.slice(7)
    if (!FAMILY.test(name)) throw new PolicyError('bad_pattern')
    return { kind: 'family', name }
  }
  const wildcards = (source.match(/\*\*|\*|\?/g) ?? []).length
  if ((source.match(/[*?]/g) ?? []).length > MAX_WILDCARDS || /\*{3,}/.test(source))
    throw new PolicyError('bad_pattern')
  if (wildcards === 0) return { kind: 'exact', text: source }
  return { kind: 'glob', text: source, literal: source.replace(/\*\*|\*|\?/g, '').length, wildcards }
}

function globToRegExp(glob: string, fold: boolean): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      out += '.*'
      i++
    } else if (c === '*') out += '[^/]*'
    else if (c === '?') out += '[^/]'
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp('^' + out + '$', fold ? 'is' : 's')
}

function ruleMatches(p: Pattern, ids: string[], family: string, fold: boolean) {
  if (p.kind === 'family') return family !== 'unknown' && family === p.name
  const text = fold ? p.text.toLowerCase() : p.text
  if (p.kind === 'exact') return ids.some((id) => (fold ? id.toLowerCase() : id) === text)
  const re = globToRegExp(p.text, fold)
  return ids.some((id) => re.test(id))
}

// Higher is more specific: exact id, then family, then glob; among globs more literal characters,
// then fewer wildcards.
function rank(p: Pattern): [number, number, number] {
  if (p.kind === 'exact') return [3, p.text.length, 0]
  if (p.kind === 'family') return [2, p.name.length, 0]
  return [1, p.literal, -p.wildcards]
}
function compare(a: [number, number, number], b: [number, number, number]) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

interface Listed {
  ok: boolean
  allows: { rule: Rule; p: Pattern }[]
  denied?: Rule
}

function consult(list: Rule[], m: ResolvedModel, fold: boolean): Listed {
  const canonical = policyId(m.vendor, m.canonicalId)
  const requested = policyId(m.vendor, m.requestedId)
  const denyIds = canonical === requested ? [canonical] : [canonical, requested]
  const parsed = list.map((rule) => {
    checkRule(rule)
    return { rule, p: parsePattern(rule.model) }
  })
  for (const { rule, p } of parsed)
    if (rule.effect === 'deny' && ruleMatches(p, denyIds, m.family, fold))
      return { ok: false, allows: [], denied: rule }
  const familyDeny = parsed.some((x) => x.rule.effect === 'deny' && x.p.kind === 'family')
  let allows = parsed.filter(
    (x) => x.rule.effect === 'allow' && ruleMatches(x.p, [canonical], m.family, fold),
  )
  // A family deny cannot see a model of unknown family. Fail closed: such a model is allowed only
  // by an exact allow rule that names it.
  if (familyDeny && m.family === 'unknown') allows = allows.filter((x) => x.p.kind === 'exact')
  return { ok: allows.length > 0, allows }
}

const isCount = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1
const isLimit = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
function checkRule(rule: Rule) {
  if (!rule || typeof rule !== 'object' || (rule.effect !== 'allow' && rule.effect !== 'deny'))
    throw new PolicyError('bad_rule')
  if (rule.tariff !== undefined && typeof rule.tariff !== 'string') throw new PolicyError('bad_rule')
  if (rule.max_tokens !== undefined && !isCount(rule.max_tokens)) throw new PolicyError('bad_rule')
  if (rule.calls !== undefined && !isCount(rule.calls)) throw new PolicyError('bad_rule')
  if (rule.expires !== undefined && !isLimit(rule.expires)) throw new PolicyError('bad_rule')
}

function minOf(values: (number | undefined)[]) {
  const v = values.filter((x): x is number => typeof x === 'number')
  return v.length ? Math.min(...v) : undefined
}

/**
 * Decide whether `connection` AND `grant` both permit the model. An empty connection list means
 * the key owner set no ceiling. The grant list must be non-empty to permit anything.
 * The price comes from the single most specific grant allow rule; every cap is the minimum across
 * all matching allow rules of both lists.
 */
export function evaluate(input: {
  model: ResolvedModel
  connection: Rule[]
  grant: Rule[]
  foldCase?: boolean
}): Decision {
  const fold = input.foldCase === true
  const c = input.connection.length ? consult(input.connection, input.model, fold) : null
  if (c && !c.ok)
    return {
      ok: false,
      code: 'model_not_permitted',
      rule: c.denied,
      reason: c.denied ? 'denied by the key policy' : 'not allowed by the key policy',
    }
  const g = consult(input.grant, input.model, fold)
  if (!g.ok)
    return {
      ok: false,
      code: 'model_not_permitted',
      rule: g.denied,
      reason: g.denied ? 'denied by a grant rule' : 'no grant rule allows this model',
    }
  let best = g.allows[0]
  let top = [best]
  for (const x of g.allows.slice(1)) {
    const cmp = compare(rank(x.p), rank(best.p))
    if (cmp > 0) {
      best = x
      top = [x]
    } else if (cmp === 0) top.push(x)
  }
  if (new Set(top.map((x) => x.rule.tariff ?? '')).size > 1)
    return {
      ok: false,
      code: 'rule_ambiguous',
      rule: best.rule,
      reason: 'two equally specific allow rules carry different tariffs',
    }
  const matched = [...g.allows.map((x) => x.rule), ...(c ? c.allows.map((x) => x.rule) : [])]
  return {
    ok: true,
    rule: best.rule,
    matched,
    caps: {
      max_tokens: minOf(matched.map((r) => r.max_tokens)),
      expires: minOf(matched.map((r) => r.expires)),
      calls: minOf(matched.map((r) => r.calls)),
    },
  }
}

export interface VoiceRule {
  effect: Effect
  voice: string
}
export type VoiceDecision =
  | { ok: true; restricted: boolean }
  | { ok: false; code: 'voice_not_permitted'; rule?: VoiceRule }

/**
 * Voice ids are part of what a grant authorizes. A grant that lists voice rules permits only the
 * voices its allow rules name, deny wins. A grant with no voice rules is unrestricted, so the
 * console must require an explicit choice when a grant carries speech operations.
 */
export function evaluateVoice(input: {
  vendor: string
  voiceId: string
  rules: VoiceRule[]
  foldCase?: boolean
}): VoiceDecision {
  if (input.rules.length === 0) return { ok: true, restricted: false }
  const id = policyId(input.vendor, input.voiceId)
  const fold = input.foldCase === true
  const parsed = input.rules.map((r) => {
    if (!r || (r.effect !== 'allow' && r.effect !== 'deny')) throw new PolicyError('bad_rule')
    return { rule: r, p: parsePattern(r.voice) }
  })
  const hit = (x: { p: Pattern }) => ruleMatches(x.p, [id], 'unknown', fold)
  const deny = parsed.find((x) => x.rule.effect === 'deny' && hit(x))
  if (deny) return { ok: false, code: 'voice_not_permitted', rule: deny.rule }
  if (parsed.some((x) => x.rule.effect === 'allow' && hit(x))) return { ok: true, restricted: true }
  return { ok: false, code: 'voice_not_permitted' }
}
