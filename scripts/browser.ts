import { chromium } from 'playwright-core'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import assert from 'node:assert/strict'
import { service } from '../server/service.ts'
import { createServer } from 'node:net'
import { once } from 'node:events'
const dir = mkdtempSync(join(tmpdir(), 'openpassword-browser-'))
const probe = createServer()
probe.listen(0, '127.0.0.1')
await once(probe, 'listening')
const port = (probe.address() as { port: number }).port
await new Promise<void>((ok) => probe.close(() => ok()))
const origin = 'http://127.0.0.1:' + port
const broker = service(dir, origin)
try {
  await broker.listen({ host: '127.0.0.1', port: Number(process.env.OPENPASSWORD_PORT || 4141) })
  const web = spawn(
    process.execPath,
    ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(port)],
    { stdio: 'ignore' },
  )
  try {
    let ready = false
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(origin + '/api/health')).ok) {
          ready = true
          break
        }
      } catch {}
      await delay(100)
    }
    assert.ok(ready, 'Production console did not reach its isolated broker')
    const browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      args:
        process.env.OPENPASSWORD_BROWSER_SINGLE_PROCESS === '1'
          ? ['--no-sandbox', '--single-process', '--no-zygote', '--disable-gpu']
          : [],
    })
    try {
      const p = await browser.newPage()
      await p.goto(origin)
      await p
        .getByLabel('Setup code', { exact: true })
        .fill(readFileSync(join(dir, 'operator.token'), 'utf8'))
      await p.getByLabel('Username').fill('operator')
      await p.getByLabel('Choose a password').fill('browser-only-fixture')
      await p.getByRole('button', { name: 'Create administrator' }).click()
      await p.getByRole('heading', { name: 'Authentication' }).waitFor()
      await p.getByText('Google · Optional').click()
      assert.equal(
        await p.locator('details[open]').getByLabel('Callback URL').inputValue(),
        origin + '/api/auth/google/callback',
      )
      await p.getByRole('button', { name: 'Connections', exact: true }).click()
      await p.getByRole('button', { name: 'Add connection' }).click()
      await p.getByRole('dialog').locator('select').first().selectOption('github_read')
      await p.getByLabel('Connection name').fill('Engineering')
      await p.getByLabel('Account identity').fill('demo@example.com')
      await p.getByLabel('Provider credential').fill('synthetic-browser-only')
      await p.getByRole('button', { name: 'Save connection' }).click()
      await p.getByText('Engineering', { exact: true }).waitFor()
      await p.getByRole('button', { name: 'Access grants', exact: true }).click()
      await p.getByRole('button', { name: 'Issue grant' }).click()
      await p.getByLabel('Device name').fill('Test device')
      await p.getByLabel('github.user.get', { exact: true }).check()
      await p.getByRole('dialog').getByRole('button', { name: 'Issue grant' }).click()
      await p.getByText('Device credentials', { exact: true }).waitFor()
      await p.getByRole('button', { name: 'Close dialog' }).click()
      await p.setViewportSize({ width: 390, height: 844 })
      await p.getByRole('button', { name: 'Integrations', exact: true }).click()
      await p.getByLabel('Search Integrations').fill('Notion')
      await p.getByRole('button', { name: /Notion/ }).click()
      await p.getByRole('dialog').getByText('notion.pages.get').waitFor()
      await p.getByRole('button', { name: 'Close dialog' }).click()
      assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      const source = await p.request.get(origin + '/openpassword-source.tar.gz')
      assert.equal(source.status(), 200)
      assert.equal((await source.body()).subarray(0, 2).toString('hex'), '1f8b')
      await p.getByRole('button', { name: 'Lock workspace' }).click()
      await p.getByLabel('Username').fill('operator')
      await p.getByLabel('Password', { exact: true }).fill('browser-only-fixture')
      await p.getByRole('button', { name: 'Sign in', exact: true }).click()
      await p.getByRole('button', { name: 'Lock workspace' }).waitFor()
      console.log(
        'Desktop login, sealed credential enrollment, scope selection, grant issuance, mobile search and details, source download and logout passed.',
      )
    } finally {
      await browser.close()
    }
  } finally {
    web.kill('SIGTERM')
  }
} finally {
  await broker.close()
  rmSync(dir, { recursive: true, force: true })
}
