import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  buildCatalogue,
  descriptor,
  expandBaseUrl,
  lifecycle,
  loadRegistry,
  reportedMatches,
  resolveModel,
  servable,
} from '../server/model-registry.ts'

const base = {
  name: 'Test',
  category: 'hoster' as const,
  status: 'verified' as const,
  substitution: 'none-documented' as const,
  auth: { kind: 'bearer' as const },
  doc_url: 'https://example.com/docs',
  endpoints: { chat: { family: 'openai-chat', base_url: 'https://api.test.example/v1', path: '/chat/completions' } },
}
const make = (over: Record<string, unknown>) => descriptor.parse({ id: 'test', ...base, ...over })

test('every shipped vendor file loads, is named by its id, and is a candidate', () => {
  const dir = fileURLToPath(new URL('../registry/vendors', import.meta.url))
  const cat = loadRegistry(dir)
  assert.equal(cat.vendors.size, readdirSync(dir).filter((f) => f.endsWith('.json')).length)
  for (const d of cat.vendors.values()) {
    assert.equal(d.status, 'candidate', d.id)
    assert.equal(servable(d), false, d.id)
    assert.ok(d.endpoints.chat.base_url.startsWith('https://'), d.id)
  }
  assert.equal(cat.vendors.get('openrouter')?.substitution, 'possible')
})

test('descriptor validation refuses unsafe or inconsistent entries', () => {
  for (const bad of [
    { endpoints: { chat: { ...base.endpoints.chat, base_url: 'http://api.test.example/v1' } } },
    { endpoints: { chat: { ...base.endpoints.chat, base_url: 'https://user:pw@api.test.example/v1' } } },
    { endpoints: { chat: { ...base.endpoints.chat, base_url: 'https://api.test.example:8443/v1' } } },
    { endpoints: { chat: { ...base.endpoints.chat, base_url: 'https://{acct}.test.example/v1' } } },
    { auth: { kind: 'header' } },
    { id: 'Bad_Id' },
    { extra: true },
    { endpoints: {} },
  ])
    assert.throws(() => descriptor.parse({ id: 'test', ...base, ...bad }), JSON.stringify(bad).slice(0, 60))
})

test('template fields cannot add a host, port, path or credentials', () => {
  const d = make({
    fields: { account_id: { kind: 'slug', max: 20 }, region: { kind: 'enum', values: ['us', 'eu'] } },
    endpoints: { chat: { ...base.endpoints.chat, base_url: 'https://api.{region}.test.example/{account_id}/v1' } },
  })
  assert.equal(expandBaseUrl(d, 'chat', { region: 'eu', account_id: 'acme-1' }), 'https://api.eu.test.example/acme-1/v1')
  for (const bad of [
    { region: 'ap', account_id: 'x' },
    { region: 'us', account_id: 'x/../y' },
    { region: 'us', account_id: 'x.evil.example' },
    { region: 'us', account_id: 'x@evil' },
    { region: 'us', account_id: 'a'.repeat(21) },
    { region: 'us', account_id: 'X' },
    { region: 'us' },
  ])
    assert.throws(() => expandBaseUrl(d, 'chat', bad as Record<string, string>), JSON.stringify(bad))
})

test('aliases and snapshots resolve to one canonical entry; family comes only from the registry', () => {
  const cat = buildCatalogue([
    make({
      models: [
        { id: 'gpt-4o', family: 'gpt-4o', aliases: ['gpt-4o-2024-08-06', 'gpt-4o-latest'] },
        { id: 'plain' },
      ],
    }),
  ])
  const a = resolveModel(cat, 'test', 'gpt-4o-2024-08-06')
  assert.deepEqual(a, { vendor: 'test', requestedId: 'gpt-4o-2024-08-06', canonicalId: 'gpt-4o', family: 'gpt-4o' })
  assert.equal(resolveModel(cat, 'test', 'plain').family, 'unknown')
  const typed = resolveModel(cat, 'test', 'never-seen')
  assert.deepEqual([typed.canonicalId, typed.family], ['never-seen', 'unknown'])
  assert.throws(() => resolveModel(cat, 'nope', 'x'))
  assert.throws(() => resolveModel(cat, 'test', 'a//b'))
})

test('one name cannot belong to two models, and case folds only when the vendor says so', () => {
  assert.throws(() =>
    buildCatalogue([make({ models: [{ id: 'a', aliases: ['x'] }, { id: 'b', aliases: ['x'] }] })]),
  )
  const strict = buildCatalogue([make({ models: [{ id: 'Model-A', family: 'f' }] })])
  assert.equal(resolveModel(strict, 'test', 'model-a').family, 'unknown')
  const folded = buildCatalogue([make({ ids_case_insensitive: true, models: [{ id: 'Model-A', family: 'f' }] })])
  assert.equal(resolveModel(folded, 'test', 'model-a').family, 'f')
})

test('models past their shutdown date or removed are refused', () => {
  const cat = buildCatalogue([
    make({
      models: [
        { id: 'old', status: 'deprecated', shutdown_on: '2027-01-06' },
        { id: 'gone', status: 'removed' },
        { id: 'new' },
      ],
    }),
  ])
  const before = new Date('2027-01-05T23:59:59Z')
  const after = new Date('2027-01-06T00:00:00Z')
  assert.equal(lifecycle(cat, 'test', 'old', before).ok, true)
  assert.deepEqual(lifecycle(cat, 'test', 'old', after), { ok: false, code: 'model_retired' })
  assert.deepEqual(lifecycle(cat, 'test', 'gone', before), { ok: false, code: 'model_retired' })
  assert.equal(lifecycle(cat, 'test', 'new', after).ok, true)
  assert.equal(lifecycle(cat, 'test', 'typed-unknown', after).ok, true)
})

test('the reported model must be the requested entry, a registered alias, or an owner-declared name', () => {
  const cat = buildCatalogue([
    make({ models: [{ id: 'gpt-4o', aliases: ['gpt-4o-2024-08-06'] }, { id: 'other' }] }),
  ])
  const req = resolveModel(cat, 'test', 'gpt-4o')
  assert.equal(reportedMatches(cat, req, 'gpt-4o'), true)
  assert.equal(reportedMatches(cat, req, 'gpt-4o-2024-08-06'), true)
  assert.equal(reportedMatches(cat, req, 'other'), false)
  assert.equal(reportedMatches(cat, req, 'unlisted-snapshot'), false)
  assert.equal(reportedMatches(cat, req, 'unlisted-snapshot', ['unlisted-snapshot']), true)
  for (const bad of [undefined, null, '', 5, {}]) assert.equal(reportedMatches(cat, req, bad), false)
})
