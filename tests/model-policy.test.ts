import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluate, evaluateVoice, parsePattern, policyId, type ResolvedModel, type Rule } from '../server/model-policy.ts'

const m = (vendor: string, id: string, family = 'unknown', canonical = id): ResolvedModel => ({
  vendor,
  requestedId: id,
  canonicalId: canonical,
  family,
})
const allow = (model: string, extra: Partial<Rule> = {}): Rule => ({ effect: 'allow', model, ...extra })
const deny = (model: string): Rule => ({ effect: 'deny', model })
const ok = (grant: Rule[], model: ResolvedModel, connection: Rule[] = []) =>
  evaluate({ model, grant, connection }).ok

test('policy ids keep the native id byte for byte and reject path tricks', () => {
  assert.equal(policyId('openrouter', 'anthropic/Claude-Fable:1.2'), 'openrouter/anthropic/Claude-Fable:1.2')
  for (const bad of ['', ' x', 'x ', 'a//b', '/a', 'a/', 'a/../b', 'a/./b', 'a\\b', 'a%2fb', 'a\u0000b', 'a b', 'a\u0085b', 'a\u2028b', 'a\u2029b', 'a\nb', 'a\u00e9b'])
    assert.throws(() => policyId('openai', bad), bad)
  assert.throws(() => policyId('OpenAI', 'gpt'))
  assert.throws(() => policyId('open/ai', 'gpt'))
})

test('star does not cross a slash, double star does, and case is preserved', () => {
  const t = m('openrouter', 'anthropic/claude-fable-5')
  assert.equal(ok([allow('openrouter/*')], t), false)
  assert.equal(ok([allow('openrouter/**')], t), true)
  assert.equal(ok([allow('openrouter/anthropic/*')], t), true)
  // `?` is exactly one character other than `/`.
  assert.equal(ok([allow('openrouter/anthropic/claude-?able-5')], t), true)
  assert.equal(ok([allow('openrouter/anthropic/claude-??able-5')], t), false)
  assert.equal(ok([allow('openrouter/anthropic?claude-fable-5')], t), false)
  assert.equal(ok([allow('openrouter/anthropic/claude-fable-?')], t), true)
  assert.equal(ok([allow('OpenRouter/**')], t), false)
  assert.equal(ok([allow('openrouter/anthropic/Claude-fable-5')], t), false)
  assert.equal(evaluate({ model: t, connection: [], grant: [allow('OPENROUTER/**')], foldCase: true }).ok, true)
})

test('deny always wins and anything unlisted is refused', () => {
  const g = [allow('openai/gpt-*-mini'), deny('openai/gpt-5-mini')]
  assert.equal(ok(g, m('openai', 'gpt-4o-mini')), true)
  assert.equal(ok(g, m('openai', 'gpt-5-mini')), false)
  assert.equal(ok(g, m('openai', 'gpt-5')), false)
  assert.equal(ok([], m('openai', 'gpt-5')), false)
  const d = evaluate({ model: m('openai', 'gpt-5-mini'), connection: [], grant: g })
  assert.equal(d.ok === false && d.code, 'model_not_permitted')
  assert.deepEqual(d.ok === false && d.rule, deny('openai/gpt-5-mini'))
})

test('the operator example: deny a model on every vendor, including through a gateway', () => {
  const g = [allow('*/**'), deny('*/**fable**')]
  assert.equal(ok(g, m('anthropic', 'claude-fable-5-2')), false)
  assert.equal(ok(g, m('openrouter', 'anthropic/claude-fable-5-2')), false)
  assert.equal(ok(g, m('openrouter', 'anthropic/claude-haiku-5-5')), true)
  // A narrower allow does not prove the deny: an OpenAI-only allow refuses Anthropic anyway.
  assert.equal(ok([allow('openai/**')], m('anthropic', 'claude-fable-5-2')), false)
})

test('a deny on the requested name applies even when an alias resolves elsewhere', () => {
  const t = m('openai', 'gpt-4o-latest', 'gpt-4o', 'gpt-4o-2024-08-06')
  assert.equal(ok([allow('openai/gpt-4o-2024-08-06')], t), true)
  assert.equal(ok([allow('openai/gpt-4o-2024-08-06'), deny('openai/gpt-4o-latest')], t), false)
  assert.equal(ok([allow('openai/gpt-4o-2024-08-06'), deny('openai/gpt-4o-2024-08-06')], t), false)
})

test('family rules match only registry families; unknown family fails closed', () => {
  const known = m('together', 'qwen/Qwen3', 'qwen')
  const other = m('together', 'meta-llama/Llama-4', 'llama')
  const stray = m('together', 'someone/new-model')
  const g = [allow('together/**'), deny('family:qwen')]
  assert.equal(ok(g, known), false)
  assert.equal(ok(g, other), true)
  // With any family deny present, an unknown-family model needs an exact allow naming it.
  assert.equal(ok(g, stray), false)
  assert.equal(ok([...g, allow('together/someone/new-model')], stray), true)
  // Without a family deny an unknown-family model follows the ordinary rules.
  assert.equal(ok([allow('together/**')], stray), true)
  // An unknown family never satisfies a family allow.
  assert.equal(ok([allow('family:qwen')], m('together', 'qwen/x')), false)
  assert.equal(ok([allow('family:qwen')], known), true)
})

test('the decision is a conjunction of the key policy and the grant', () => {
  const key = [allow('openai/**'), deny('openai/o3*')]
  const t = (id: string) => m('openai', id)
  assert.equal(ok([allow('openai/**')], t('gpt-5'), key), true)
  assert.equal(ok([allow('openai/**')], t('o3-pro'), key), false)
  assert.equal(ok([allow('anthropic/**')], t('gpt-5'), key), false)
  assert.equal(ok([allow('openai/gpt-5')], t('gpt-5-mini'), key), false)
  // A grant can never widen the key: the key refuses, whatever the grant says.
  assert.equal(ok([allow('**'), allow('*/**')], m('xai', 'grok'), key), false)
  // An empty key list means the owner set no ceiling.
  assert.equal(ok([allow('xai/**')], m('xai', 'grok'), []), true)
})

test('the most specific allow rule prices the call; caps are the minimum of all matching rules', () => {
  const g = [
    allow('openai/**', { tariff: 'broad', max_tokens: 4000, calls: 100 }),
    allow('openai/gpt-*', { tariff: 'mid', max_tokens: 2000 }),
    allow('openai/gpt-5-mini', { tariff: 'exact', max_tokens: 3000, expires: 500 }),
  ]
  const d = evaluate({ model: m('openai', 'gpt-5-mini'), connection: [], grant: g })
  assert.ok(d.ok)
  assert.equal(d.ok && d.rule.tariff, 'exact')
  assert.deepEqual(d.ok && d.caps, { max_tokens: 2000, expires: 500, calls: 100 })
  const mid = evaluate({ model: m('openai', 'gpt-4o'), connection: [], grant: g })
  assert.equal(mid.ok && mid.rule.tariff, 'mid')
  // More literal characters beat fewer.
  const lit = evaluate({
    model: m('openai', 'gpt-5-mini'),
    connection: [],
    grant: [allow('openai/g*', { tariff: 'a' }), allow('openai/gpt-5*', { tariff: 'b' })],
  })
  assert.equal(lit.ok && lit.rule.tariff, 'b')
  // A family rule is more specific than any glob and less than an exact id.
  const fam = evaluate({
    model: m('together', 'qwen/Qwen3', 'qwen'),
    connection: [],
    grant: [allow('together/**', { tariff: 'glob' }), allow('family:qwen', { tariff: 'family' })],
  })
  assert.equal(fam.ok && fam.rule.tariff, 'family')
})

test('equally specific rules with different tariffs are refused as ambiguous', () => {
  const t = m('openai', 'gpt-5')
  const d = evaluate({ model: t, connection: [], grant: [allow('openai/g*t-5', { tariff: 'x' }), allow('openai/gp*-5', { tariff: 'y' })] })
  assert.equal(d.ok === false && d.code, 'rule_ambiguous')
  // The same tariff is not ambiguous, whichever rule is picked.
  const same = evaluate({ model: t, connection: [], grant: [allow('openai/g*t-5', { tariff: 'x' }), allow('openai/gp*-5', { tariff: 'x' })] })
  assert.ok(same.ok)
})

test('patterns are validated', () => {
  for (const bad of ['', ' a', 'a b', 'a\\b', 'family:', 'family:Bad Name', 'a%b', '*'.repeat(9), '***', 'a/?'.repeat(9), 'x'.repeat(201), 'a\u2028*', 'a\u0085?', '\u00e9*'])
    assert.throws(() => parsePattern(bad), bad)
  assert.equal(parsePattern('openai/gpt-5').kind, 'exact')
  assert.equal(parsePattern('family:qwen').kind, 'family')
  assert.equal(parsePattern('openai/*').kind, 'glob')
})

test('voice ids are part of the authorization', () => {
  const rules = [
    { effect: 'allow' as const, voice: 'elevenlabs/stock-*' },
    { effect: 'deny' as const, voice: 'elevenlabs/stock-celebrity' },
  ]
  const v = (id: string) => evaluateVoice({ vendor: 'elevenlabs', voiceId: id, rules })
  assert.deepEqual(v('stock-anna'), { ok: true, restricted: true })
  assert.equal(v('stock-celebrity').ok, false)
  assert.equal(v('cloned-owner-voice').ok, false)
  assert.equal(evaluateVoice({ vendor: 'rime', voiceId: 'stock-anna', rules }).ok, false)
  // No voice rules: unrestricted, and the result says so.
  assert.deepEqual(evaluateVoice({ vendor: 'rime', voiceId: 'anything', rules: [] }), { ok: true, restricted: false })
  assert.throws(() => evaluateVoice({ vendor: 'rime', voiceId: 'a/../b', rules }))
})

test('one id alphabet: no line terminator or non-ASCII character is an id or matches a wildcard', () => {
  for (const c of ['\u0085', '\u2028', '\u2029', '\n', '\r', '\u00e9'])
    assert.throws(() => policyId('openai', 'gpt-' + c + '5'), c)
  // Every admitted character is matched by `**`, so a deny and an allow see the same ids.
  const all = Array.from({ length: 0x7e - 0x21 + 1 }, (_, i) => String.fromCharCode(0x21 + i)).filter((c) => c !== '\\' && c !== '%' && c !== '/')
  for (const c of all) {
    const t = m('openrouter', 'a' + c + 'b')
    assert.equal(ok([allow('openrouter/**')], t), true, c)
    assert.equal(ok([allow('openrouter/**'), deny('openrouter/a?b')], t), false, c)
  }
})

test('rule data is validated before matching and fails closed', () => {
  const t = m('openai', 'gpt-5')
  const run = (extra: object) => () => evaluate({ model: t, connection: [], grant: [{ effect: 'allow', model: 'openai/**', ...extra } as Rule] })
  for (const bad of [
    { max_tokens: NaN },
    { max_tokens: Infinity },
    { max_tokens: 0 },
    { max_tokens: -1 },
    { max_tokens: 1.5 },
    { max_tokens: '10' },
    { calls: 0 },
    { calls: 2 ** 53 },
    { calls: null },
    { expires: -1 },
    { expires: NaN },
    { expires: '5' },
    { expires: 1.2 },
    { tariff: 5 },
  ])
    assert.throws(run(bad), JSON.stringify(bad))
  assert.throws(() => evaluate({ model: t, connection: [{ effect: 'maybe', model: 'openai/**' } as unknown as Rule], grant: [] }))
  assert.throws(() => evaluateVoice({ vendor: 'rime', voiceId: 'x', rules: [{ effect: 'allow ', voice: 'rime/*' } as never] }))
  const d = run({ max_tokens: 10, calls: 1, expires: 0 })()
  assert.deepEqual(d.ok && d.caps, { max_tokens: 10, expires: 0, calls: 1 })
})
