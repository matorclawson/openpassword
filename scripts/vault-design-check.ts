// Runs against a disposable local broker and the production web build.
import { chromium } from 'playwright-core'
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert/strict'
import { service } from '../server/service.ts'
const out = resolve(process.env.DESIGN_OUTPUT || 'design-evidence'),
  home = mkdtempSync(join(tmpdir(), 'vault-review-'))
mkdirSync(out, { recursive: true })
const port = 3647,
  origin = 'http://127.0.0.1:' + port
const broker = service(home, origin)
await broker.listen({ host: '127.0.0.1', port: 4141 })
const web = spawn(
  process.execPath,
  ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(port)],
  { stdio: 'ignore' },
)
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  args: process.env.OPENPASSWORD_BROWSER_SINGLE_PROCESS
    ? ['--no-sandbox', '--single-process', '--no-zygote', '--disable-gpu']
    : [],
})
try {
  const p = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  const snap = async (name: string) => {
    await p.evaluate(() => document.fonts.ready)
    await p.screenshot({ path: join(out, name + '.png') })
  }
  const pair = async (name: string) => {
    for (const theme of ['light', 'dark']) {
      await p.getByLabel('Appearance').selectOption(theme)
      await snap(name + '-' + theme)
    }
  }
  for (let n = 0; n < 80; n++) {
    try {
      if ((await fetch(origin)).ok) break
    } catch {}
    await new Promise((r) => setTimeout(r, 150))
  }
  if (process.env.DESIGN_SPECIMEN) {
    await p.goto('file://' + resolve(process.env.DESIGN_SPECIMEN))
    await p.locator('#theme').selectOption({ label: 'Dark' })
    await p.locator('summary').click()
    assert.equal(await p.locator('details[open]').count(), 1)
  }
  await p.goto(origin)
  await p.getByLabel('Setup code', { exact: true }).waitFor()
  await pair('onboarding')
  const post = async (path: string, data: object) => {
    const r = await p.request.post(origin + '/api/' + path, { data })
    assert.ok(r.ok(), path + ' ' + r.status())
    return r.json()
  }
  await post('auth/setup', {
    token: readFileSync(join(home, 'operator.token'), 'utf8').trim(),
    username: 'reviewer',
    password: 'disposable-test-secret',
  })
  const names = [
    'Build registry',
    'Design archive',
    'Package signing',
    'Release registry',
    'Research notebook',
    'Staging console',
    'Translation workspace access ' + 'X'.repeat(44),
  ]
  let target = '',
    long = ''
  for (const [n, title] of names.entries()) {
    const x = await post('admin/items', {
      title,
      username: [
        'build@studio.example',
        'design@studio.example',
        'signing-bot',
        'release@studio.example',
        'lab@studio.example',
        'staging-bot',
        'localization-team',
      ][n],
      value: 'DEMO-ONLY-NEVER-CAPTURE',
    })
    if (n === 3) target = x.id
    if (n === 6) long = x.id
  }
  await p.goto(origin + '/vault')
  await p.locator('.vaultRow').first().waitFor()
  await pair('vault')
  const contrast: Record<string, unknown> = {}
  for (const theme of ['light', 'dark']) {
    await p.getByLabel('Appearance').selectOption(theme)
    const primary = p.getByRole('button', { name: 'Add item' })
    const samples: Record<string, unknown> = {}
    async function measure(name: string, selector: string, focus = false) {
      samples[name] = await p
        .locator(selector)
        .first()
        .evaluate((el, focus) => {
          const c = getComputedStyle(el)
          let parent: Element | null = el
          let bg = 'rgba(0, 0, 0, 0)'
          while (parent && bg === 'rgba(0, 0, 0, 0)') {
            bg = getComputedStyle(parent).backgroundColor
            parent = parent.parentElement
          }
          const fg = focus ? c.outlineColor : c.color
          const ctx = document.createElement('canvas').getContext('2d')!
          const [a, b] = [fg, bg].map((color) => {
            ctx.fillStyle = color
            ctx.fillRect(0, 0, 1, 1)
            const [r, g, b] = [...ctx.getImageData(0, 0, 1, 1).data].map((v) => {
              const t = v / 255
              return t <= 0.04045 ? t / 12.92 : ((t + 0.055) / 1.055) ** 2.4
            })
            return 0.2126 * r + 0.7152 * g + 0.0722 * b
          })
          return {
            foreground: fg,
            background: bg,
            ratio: +((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2),
            outline: focus ? c.outlineWidth : undefined,
          }
        }, focus)
    }
    await p.mouse.move(0, 0)
    await measure('primary', '.vaultIntro button')
    await primary.hover()
    await measure('hover', '.vaultIntro button')
    await primary.evaluate((b) => ((b as HTMLButtonElement).disabled = true))
    await measure('disabled', '.vaultIntro button')
    await primary.evaluate((b) => ((b as HTMLButtonElement).disabled = false))
    await measure('row-title', '.rowText strong')
    await measure('account', '.rowText small')
    await p.keyboard.press('Control+k')
    await p.keyboard.press('ArrowDown')
    await measure('row-focus', '.vaultRow:focus-visible', true)
    contrast[theme] = samples
  }
  writeFileSync(join(out, 'contrast.json'), JSON.stringify(contrast, null, 2))
  await p.keyboard.press('Control+k')
  await p.keyboard.type('missing-filter')
  await p.getByRole('button', { name: 'Clear vault search' }).click()
  assert.equal(await p.getByLabel('Search vault items').inputValue(), '')
  await p.keyboard.type('Release')
  await p.waitForFunction(() => document.querySelectorAll('.vaultRow').length === 1)
  await p.keyboard.press('ArrowDown')
  const listMark = await p.locator('.vaultRow .recordMark').evaluate((el) => el.outerHTML)
  await p.keyboard.press('Enter')
  await p.getByRole('heading', { name: 'Release registry' }).waitFor()
  assert.equal(new URL(p.url()).pathname, '/vault/' + target)
  assert.equal(
    await p.locator('.recordHeader .recordMark').evaluate((el) => el.outerHTML),
    listMark,
  )
  await pair('reader')
  const reveal = p.getByRole('button', { name: 'Reveal stored value' })
  await reveal.click()
  await p.getByLabel('Revealed value').waitFor()
  await p.getByRole('button', { name: 'Hide stored value' }).click()
  await p.goBack()
  await p.waitForFunction(() => document.activeElement?.classList.contains('vaultRow'))
  assert.equal(await p.getByLabel('Search vault items').inputValue(), 'Release')
  await p.goto(origin + '/vault/' + target)
  await p.reload()
  await reveal.waitFor()
  assert.equal(await p.getByLabel('Value hidden').count(), 1)
  await p.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin })
  await p.getByRole('button', { name: 'Copy stored value' }).click()
  await p.getByText('Value copied', { exact: true }).waitFor()
  assert.equal(await p.getByLabel('Value hidden').count(), 1)
  await p.clock.install()
  await reveal.click()
  await p.getByLabel('Revealed value').waitFor()
  await p.clock.fastForward(31000)
  await p.getByLabel('Value hidden').waitFor()
  await p.getByLabel('Appearance').selectOption('system')
  await p.emulateMedia({ colorScheme: 'light' })
  await p.waitForFunction(() => document.documentElement.dataset.palette === 'light')
  await p.emulateMedia({ colorScheme: 'dark' })
  await p.waitForFunction(() => document.documentElement.dataset.palette === 'dark')
  await p.getByRole('link', { name: 'Item activity' }).click()
  await p.getByText('Vault item revealed', { exact: true }).first().waitFor()
  await p.goto(origin + '/vault/' + long)
  const widths = []
  for (const width of [320, 390, 768, 1440]) {
    await p.setViewportSize({ width, height: 844 })
    await p.getByRole('heading', { name: names[6] }).waitFor()
    const measured = await p.evaluate(() => ({
      width: innerWidth,
      document: document.documentElement.scrollWidth,
      touch: document.querySelector('[aria-label="Reveal stored value"]')?.getBoundingClientRect()
        .height,
    }))
    widths.push(measured)
    assert.equal(measured.document, width)
    if (width <= 768) assert.ok(Number(measured.touch) >= 48)
    if (width === 390) await snap('reader-phone')
  }
  await p.evaluate(() => {
    document.documentElement.style.zoom = '2'
  })
  assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await p.evaluate(() => {
    document.documentElement.style.zoom = '1'
  })
  await p.goto(origin + '/vault/missing-review-item')
  await p.locator('.vaultNotice[role=alert]').waitFor()
  await pair('error')
  for (const theme of ['light', 'dark']) {
    await p.getByLabel('Appearance').selectOption(theme)
    const colors = await p.locator('.vaultNotice[role=alert]').evaluate((el) => ({
      ink: getComputedStyle(el).color,
      paper: getComputedStyle(el).backgroundColor,
    }))
    ;(contrast[theme] as Record<string, unknown>).error = colors
  }
  writeFileSync(join(out, 'contrast.json'), JSON.stringify(contrast, null, 2))
  for (const [path, heading] of [
    ['integrations', 'Integrations'],
    ['connections', 'Connections'],
    ['grants', 'Access grants'],
    ['consumption', 'Consumption'],
    ['activity', 'Activity'],
    ['approvals', 'Approvals'],
    ['workspace', 'Workspace'],
  ]) {
    await p.goto(origin + '/' + path)
    await p.getByRole('heading', { name: heading, exact: true, level: 1 }).waitFor()
    await snap('console-' + path)
  }
  const ws = await (await p.request.get(origin + '/api/admin/workspace?items=paged')).json()
  const member = await post('admin/members', { label: 'Review viewer', role: 'viewer' })
  const db = new DatabaseSync(join(home, 'vault.sqlite'))
  try {
    db.exec('BEGIN')
    const ins = db.prepare('INSERT INTO items VALUES(?,?,?,?,?,?)')
    for (let i = 0; i < 10000; i++)
      ins.run(
        'fixture_' + i,
        ws.tenant,
        'Sample ' + String(i).padStart(5, '0'),
        'fixture@studio.example',
        'unread-metadata-fixture',
        Date.now(),
      )
    db.exec('COMMIT')
  } finally {
    db.close()
  }
  const times = []
  let bytes = 0
  for (let i = 0; i < 50; i++) {
    const t = performance.now()
    const r = await p.request.get(origin + '/api/admin/items?q=Sample&page=' + (i + 1))
    const b = await r.body()
    times.push(performance.now() - t)
    bytes = b.length
    assert.equal(JSON.parse(b.toString()).rows.length, 30)
  }
  times.sort((a, b) => a - b)
  const ids = new Set<string>()
  for (let page = 1; page <= 334; page++) {
    const response = await p.request.get(origin + '/api/admin/items?q=Sample&page=' + page)
    for (const item of (await response.json()).rows) {
      assert.ok(!ids.has(item.id))
      ids.add(item.id)
    }
  }
  assert.equal(ids.size, 10000)
  await p.goto(origin + '/vault')
  await p.locator('.vaultRow').first().waitFor()
  assert.equal(await p.locator('.vaultRow').count(), 30)
  await p.setViewportSize({ width: 320, height: 780 })
  await p.locator('.directoryTools>span').evaluate((el) => (el.textContent = '999,999,999 items'))
  await p
    .getByRole('button', { name: 'Add item' })
    .evaluate((el) => (el.textContent = 'Gespeicherten Anmeldeeintrag hinzufügen'))
  assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await p.setViewportSize({ width: 1440, height: 960 })
  await p.route('**/api/admin/items?*', (r) => r.abort())
  await p.getByLabel('Search vault items').fill('offline')
  await p.getByRole('button', { name: 'Try again' }).waitFor()
  await p.unroute('**/api/admin/items?*')
  await p.getByRole('button', { name: 'Try again' }).click()
  await p.getByRole('heading', { name: 'No matching items' }).waitFor()
  const other = await post('admin/workspaces', { label: 'Second workspace' })
  await post('admin/switch', { id: other.id })
  for (const suffix of ['', '/history'])
    assert.equal(
      (await p.request.get(origin + '/api/admin/items/' + target + suffix)).status(),
      404,
    )
  assert.equal(
    (
      await p.request.post(origin + '/api/admin/items/' + target + '/reveal', { data: {} })
    ).status(),
    404,
  )
  assert.equal((await (await p.request.get(origin + '/api/admin/items')).json()).total, 0)
  await post('admin/switch', { id: ws.tenant })
  await p.goto(origin + '/vault/' + target)
  await reveal.click()
  await p.getByLabel('Revealed value').waitFor()
  await p.getByRole('button', { name: 'Lock workspace' }).click()
  await p.getByLabel('Username').waitFor()
  assert.equal(await p.getByText('DEMO-ONLY-NEVER-CAPTURE').count(), 0)
  await post('admin/login', { token: member.token })
  await p.goto(origin + '/vault/' + target)
  await p.getByText('Metadata only', { exact: true }).waitFor()
  assert.equal(await reveal.count(), 0)
  assert.equal(
    (
      await p.request.post(origin + '/api/admin/items/' + target + '/reveal', { data: {} })
    ).status(),
    403,
  )
  writeFileSync(
    join(out, 'browser.json'),
    JSON.stringify(
      {
        browser: browser.version(),
        widths,
        seeded: 10007,
        rowsMounted: 30,
        disjointPages: 334,
        disconnectedRetry: true,
        simulatedLargeCountAndLongLabel: true,
        lastPayloadBytes: bytes,
        httpSearchP50ms: times[25],
        httpSearchP95ms: times[47],
        samples: 50,
        maskTimeoutSeconds: 30,
        lockMask: true,
        copyMasked: true,
        systemFollowsMedia: true,
        cssZoom200: true,
        keyboardBack: true,
        detailReload: true,
        viewerReveal: 403,
        foreignWorkspaceDetailHistoryReveal: 404,
      },
      null,
      2,
    ),
  )
} finally {
  await browser.close()
  web.kill()
  await broker.close()
  rmSync(home, { force: true, recursive: true })
}
