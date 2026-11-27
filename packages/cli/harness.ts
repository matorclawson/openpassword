// Native launchers use the same token store, host signer and broker client as an interactive CLI.
import { mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { OpenPassword } from '@openpassword/client'

const skills: Record<string, string> = {
  'claude-code': '.claude/skills',
  codex: '.agents/skills',
  cursor: '.cursor/skills',
  agi: '.agents/skills',
  antigravity: '.agents/skills',
  'gemini-cli': '.gemini/skills',
  'github-copilot': '.github/skills',
  'grok-build': '.grok/skills',
  opencode: '.opencode/skills',
}
export const targets = [
  ...Object.keys(skills),
  'grokbot',
  'deepagents',
  'agno',
  'rasa',
  'openai-agents',
  'langchain',
  'typescript',
]
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'"

export function prepareHarness(target: string, directory: string, standalone = false) {
  if (!targets.includes(target)) throw Error('Choose a harness: ' + targets.join(', '))
  if (typeof process.getuid !== 'function') throw Error('Prepare native adapters on Linux or macOS')
  const broker = process.env.OPENPASSWORD_BROKER,
    agent = process.env.OPENPASSWORD_AGENT?.trim(),
    socket = process.env.OPENPASSWORD_HOST_SOCKET
  if (!broker || !agent || (!standalone && (!socket || !isAbsolute(socket))))
    throw Error(
      'Set OPENPASSWORD_BROKER, OPENPASSWORD_AGENT and an absolute OPENPASSWORD_HOST_SOCKET before preparing the adapter.',
    )
  if (standalone && socket)
    throw Error('A host socket is configured. Omit --standalone to preserve host signing.')
  const origin = new OpenPassword(broker).origin
  const root = resolve(directory),
    launcher = join(root, 'openpassword-agent'),
    exe = realpathSync(process.argv[1])
  if ([root, exe, agent, socket || ''].some((s) => /[\r\n\x00]/.test(s)))
    throw Error('Paths and profile names must be single-line values.')
  const fixed = [
    'HOME=' + homedir(),
    'PATH=/usr/bin:/bin',
    'OPENPASSWORD_BROKER=' + origin,
    'OPENPASSWORD_AGENT=' + agent,
  ]
  if (socket) fixed.push('OPENPASSWORD_HOST_SOCKET=' + socket)
  // Private CA roots are a deployment setting. Never inherit arbitrary Node loader flags.
  if (process.env.NODE_EXTRA_CA_CERTS)
    fixed.push('NODE_EXTRA_CA_CERTS=' + realpathSync(process.env.NODE_EXTRA_CA_CERTS))
  const script = [
    '#!/bin/sh',
    'set -eu',
    'test "$(/usr/bin/id -u)" = ' +
      quote(String(process.getuid())) +
      ' || { echo "Wrong OS account for this agent" >&2; exit 1; }',
    'case "${1-}" in',
    '  whoami|capabilities|connections|models|activity|mcp|invoke-json) [ "$#" = 1 ] ;;',
    '  operation) [ "$#" = 3 ] ;;',
    '  chat) [ "$#" = 4 ] ;;',
    '  *) echo "Use whoami, capabilities, connections, models, activity, operation, invoke-json, chat or mcp" >&2; exit 2 ;;',
    'esac',
    'exec /usr/bin/env -i ' + [...fixed, process.execPath, exe].map(quote).join(' ') + ' "$@"',
    '',
  ].join('\n')
  const workflow = `---
name: openpassword
description: Inspect this agent's grant and use authorized provider operations through its local OpenPassword client.
---

Use the local command runner on this agent host. Run ${quote(launcher)} whoami, then ${quote(launcher)} capabilities. Use only an operation listed for the task. For a GitHub identity request, locate github.user.get, then run the command below with a unique request key for this task.

    printf '%s' '{}' | ${quote(launcher)} operation github.user.get YOUR_REQUEST_KEY

The adapter resolves the grant's connection and supplies the current identity and revision to the broker. Generate a fresh idempotency key for a new action and reuse it only for retries of that same action. If the grant is expired, revoked or awaiting approval, report that state to the operator. Return the requested provider result. Keep the enrollment token, host key and device token store outside the conversation.
`
  mkdirSync(dirname(root), { recursive: true })
  mkdirSync(root, { mode: 0o700 }) // A second run must never replace a live agent profile.
  try {
    writeFileSync(launcher, script, { mode: 0o700 })
    if (skills[target]) {
      const dest = join(root, skills[target], 'openpassword')
      mkdirSync(dest, { recursive: true })
      writeFileSync(join(dest, 'SKILL.md'), workflow)
    } else if (target === 'grokbot') writeFileSync(join(root, 'grokbot-skill.md'), workflow)
    if (['codex', 'grok-build'].includes(target)) {
      // TOML basic strings accept these JSON escapes for a single-line filesystem path.
      writeFileSync(
        join(root, 'mcp.toml'),
        '[mcp_servers.openpassword]\ncommand = ' + JSON.stringify(launcher) + '\nargs = ["mcp"]\n',
      )
    } else if (target in skills && target !== 'agi') {
      const server = { command: launcher, args: ['mcp'] }
      const config =
        target === 'opencode'
          ? { mcp: { openpassword: { type: 'local', command: [launcher, 'mcp'], enabled: true } } }
          : target === 'github-copilot'
            ? { servers: { openpassword: { type: 'stdio', ...server } } }
            : { mcpServers: { openpassword: server } }
      writeFileSync(join(root, 'mcp.json'), JSON.stringify(config, null, 2) + '\n')
    }
    return launcher
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}
