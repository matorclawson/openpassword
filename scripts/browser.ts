import { chromium } from 'playwright-core'
import { spawn, execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
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
      const contract = await p.request.get(origin + '/v1/openapi.json')
      assert.equal(contract.status(), 200)
      assert.equal((await contract.json()).openapi, '3.1.0')
      const pair = await p.request.post(origin + '/v1/device/authorizations', {
        headers: { 'OpenPassword-Protocol-Version': '1' },
        data: { device_name: 'remote client' },
      })
      assert.equal(pair.status(), 200)
      assert.equal((await pair.json()).verification_url, origin + '/device')
      await p.goto(origin)
      const cli = (command: string, input = '') =>
        new Promise<string>((resolve, reject) => {
          const child = execFile(
            process.execPath,
            ['public/openpassword-cli.cjs', ...command.split(' ')],
            {
              env: {
                ...process.env,
                HOME: dir,
                OPENPASSWORD_HOME: dir,
                OPENPASSWORD_BROKER: origin,
              },
            },
            (err, stdout) =>
              err ? reject(Error('Test CLI failed: ' + command)) : resolve(stdout.trim()),
          )
          child.stdin!.end(input)
        })
      await p.getByLabel('Setup code', { exact: true }).fill(await cli('setup-code'))
      await p.getByLabel('Username').fill('operator')
      await p.getByLabel('Choose a password').fill('browser-only-fixture')
      await p.getByRole('button', { name: 'Create administrator' }).click()
      await p.getByRole('heading', { name: 'Authentication' }).waitFor()
      await p.getByText('Google · Optional').click()
      assert.equal(
        await p.locator('details[open]').getByLabel('Callback URL').inputValue(),
        origin + '/api/auth/google/callback',
      )
      await p.getByRole('link', { name: 'Connections', exact: true }).click()
      await p.getByRole('button', { name: 'Add connection' }).click()
      await p.getByRole('dialog').locator('select').first().selectOption('github_read')
      await p.getByLabel('Credential owner').selectOption('personal')
      await p.getByRole('button', { name: 'In 7 days', exact: true }).click()
      assert.ok(await p.getByLabel('Credential expiry').inputValue())
      await p.getByLabel('Connection name').fill('Engineering')
      await p.getByLabel('Account identity').fill('demo@example.com')
      await p.getByLabel('Provider credential').fill('synthetic-browser-only')
      await p.getByRole('button', { name: 'Save connection' }).click()
      await p.getByText('Engineering', { exact: true }).waitFor()
      await p.getByRole('button', { name: 'Edit access' }).click()
      await p.getByLabel('Who can use this credential?').selectOption('organization')
      await p.getByRole('button', { name: 'Save changes' }).click()
      await p.getByText(/Owned by you.*Whole organization/).waitFor()
      await p.getByRole('link', { name: 'Access grants', exact: true }).click()
      await p.getByRole('button', { name: 'Issue grant' }).click()
      await p.getByLabel('Agent name').fill('Test device')
      await p.getByLabel('github.user.get', { exact: true }).check()
      await p.getByRole('dialog').getByRole('button', { name: 'Issue grant' }).click()
      await p.getByText('Agent credentials', { exact: true }).waitFor()
      const ticket = await p.getByRole('dialog').locator('pre').last().innerText()
      const enrolled = JSON.parse(await cli('connect', ticket + '\n'))
      assert.deepEqual(JSON.parse(await cli('whoami')), enrolled)
      await p.getByRole('button', { name: 'Close dialog' }).click()
      assert.equal((await p.request.get(origin + '/openpassword-cli.cjs')).status(), 200)
      const challenge = await pair.json()
      await p.getByRole('button', { name: 'Issue grant' }).click()
      await p.getByLabel('Agent name').fill('Remote Codex')
      await p.getByLabel('Existing CLI pairing code (optional)').fill(challenge.user_code)
      await p.getByLabel('github.user.get', { exact: true }).check()
      await p.getByRole('dialog').getByRole('button', { name: 'Issue grant' }).click()
      const headers = { 'OpenPassword-Protocol-Version': '1' }
      await p.getByRole('dialog').waitFor({ state: 'hidden' })
      const redeemed = await p.request.post(origin + '/v1/device/token', {
        headers,
        data: { device_code: challenge.device_code },
      })
      assert.equal(redeemed.status(), 200)
      const token = await redeemed.json()
      const capabilities = await p.request.get(origin + '/v1/capabilities', {
        headers: { ...headers, Authorization: 'Bearer ' + token.access_token },
      })
      assert.equal(capabilities.status(), 200)
      assert.match(await capabilities.text(), /github.user.get/)
      await p.getByRole('link', { name: 'Activity', exact: true }).click()
      await p.getByText('Live', { exact: true }).waitFor()
      assert.equal(new URL(p.url()).pathname, '/activity')
      await p.request.delete(origin + '/api/admin/grants/' + token.device_id)
      await p.getByText('Access revoked', { exact: true }).waitFor()
      await p.reload()
      await p.getByText('Access revoked', { exact: true }).waitFor()
      await p.getByRole('link', { name: 'Consumption', exact: true }).click()
      await p.getByText('No brokered API requests in this period.').waitFor()
      await p.getByLabel('Group by').selectOption('agent')
      await p.goBack()
      await p.getByRole('heading', { name: 'Activity', exact: true }).waitFor()
      await p.goForward()
      await p.getByLabel('Group by').waitFor()
      await p.setViewportSize({ width: 390, height: 844 })
      await p.getByRole('button', { name: 'Menu', exact: true }).click()
      await p.getByRole('link', { name: 'Integrations', exact: true }).click()
      await p.getByLabel('Search Integrations').fill('Notion')
      await p.getByRole('button', { name: /Notion/ }).click()
      await p.getByRole('dialog').getByText('notion.pages.get').waitFor()
      await p.getByRole('button', { name: 'Close dialog' }).click()
      assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      const source = await p.request.get(origin + '/openpassword-source.tar.gz')
      assert.equal(source.status(), 200)
      assert.equal((await source.body()).subarray(0, 2).toString('hex'), '1f8b')
      if (!(await p.getByRole('button', { name: 'Lock workspace' }).isVisible()))
        await p.getByRole('button', { name: 'Menu', exact: true }).click()
      await p.getByRole('button', { name: 'Lock workspace' }).click()
      await p.getByLabel('Username').fill('operator')
      await p.getByLabel('Password', { exact: true }).fill('browser-only-fixture')
      await p.getByRole('button', { name: 'Sign in', exact: true }).click()
      await p.getByRole('button', { name: 'Menu', exact: true }).waitFor()
      await p.setViewportSize({ width: 1280, height: 900 })
      await p.goto(origin + '/private-vault')
      await p.getByRole('button', { name: 'Create my private vault' }).click()
      const recovery = await p
        .locator('label')
        .filter({ hasText: 'Save this private vault key' })
        .locator('code')
        .innerText()
      await p.getByLabel('Confirm your saved key').fill(recovery)
      await p.getByLabel('Vault passphrase').fill('synthetic browser passphrase')
      await p.getByRole('button', { name: 'Unlock private vault' }).click()
      await p.getByRole('button', { name: 'Add private item' }).click()
      await p.getByLabel('Item name', { exact: true }).fill('Private synthetic credential')
      await p.getByLabel('Secret', { exact: true }).fill('synthetic-private-value')
      await p.getByRole('button', { name: 'Save private item' }).click()
      await p.getByRole('button', { name: 'Private synthetic credential' }).click()
      await p.getByRole('button', { name: 'Reveal secret' }).click()
      await p.getByText('synthetic-private-value', { exact: true }).waitFor()
      await p.getByRole('button', { name: 'Hide secret' }).click()
      await p.getByRole('button', { name: 'Delegate to gateway' }).click()
      await p.getByLabel('Provider', { exact: true }).selectOption('github_read')
      await p.getByLabel('Gateway connection name').fill('Delegated fixture')
      await p.getByLabel('Provider account identity').fill('synthetic-account')
      await p.getByRole('button', { name: 'Authorize gateway copy' }).click()
      await p.getByText(/Gateway copy created/).waitFor()
      await p.getByRole('button', { name: 'Lock private vault' }).click()
      await p.getByLabel('Private vault key', { exact: true }).fill(recovery)
      await p.getByLabel('Vault passphrase').fill('synthetic browser passphrase')
      await p.getByRole('button', { name: 'Unlock private vault' }).click()
      await p.getByRole('button', { name: 'Private synthetic credential' }).click()
      await p.getByRole('link', { name: 'Delegated fixture' }).waitFor()
      await p.goto(origin + '/workspace')
      await p.getByLabel('Host name').fill('Synthetic build host')
      await p.getByRole('button', { name: 'Issue host enrollment token' }).click()
      const ticketArea = p
        .locator('section')
        .filter({ has: p.getByRole('button', { name: 'Hide token' }) })
      const hostTicket = await ticketArea.locator('code').last().innerText()
      assert.match(await cli('host connect', hostTicket + '\n'), /Host enrolled/)
      await p.reload()
      await p
        .locator('article')
        .filter({ hasText: 'Synthetic build host' })
        .getByText('Connected', { exact: true })
        .waitFor()
      console.log(
        'Desktop login, sealed credential enrollment, scope selection, grant issuance, mobile search and details, source download, logout, private vault recovery and delegation, and host enrollment passed.',
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
