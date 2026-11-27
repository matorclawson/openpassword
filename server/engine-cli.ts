import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
export class EngineCli {
  private child
  private lines
  private group
  private timeoutMs
  constructor(
    binary: string,
    database: string,
    epochDir?: string,
    timeoutMs = 10000,
  ) {
    // Behind the guardian shell the engine is a grandchild: its own process group lets one signal
    // reach both, even when the engine is stuck.
    this.group = !!epochDir
    this.timeoutMs = timeoutMs
    this.child = spawn(
      epochDir ? '/bin/sh' : binary,
      epochDir
        ? [
            fileURLToPath(new URL('./engine-guardian.sh', import.meta.url)),
            'workflow',
            epochDir,
            binary,
            database,
          ]
        : [database],
      {
        stdio: ['pipe', 'pipe', 'ignore'],
        env: { NODE_ENV: 'production' },
        detached: this.group,
      },
    )
    this.child.on('error', () => {})
    this.child.stdin.on('error', () => {})
    this.lines = createInterface({ input: this.child.stdout })[Symbol.asyncIterator]()
  }
  // The caller serializes commands. Every failed request terminates the upstream CLI.
  async call(request: Record<string, unknown>) {
    if (this.child.exitCode !== null || this.child.stdin.destroyed)
      throw Error('Workflow engine unavailable')
    let timeout: NodeJS.Timeout | undefined
    const expired = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        this.kill()
        reject(Error('Workflow engine timed out'))
      }, this.timeoutMs)
    })
    try {
      this.child.stdin.write(JSON.stringify(request) + '\n')
      const line = await Promise.race([this.lines.next(), expired])
      if (line.done) throw Error('Workflow engine closed')
      return JSON.parse(line.value)
    } finally {
      clearTimeout(timeout)
    }
  }
  private kill() {
    try {
      if (this.group && this.child.pid) process.kill(-this.child.pid, 'SIGKILL')
      else this.child.kill('SIGKILL')
    } catch {
      // Already gone.
    }
    this.child.stdin.destroy()
    this.child.stdout.destroy()
  }
  close() {
    this.child.stdin.end()
    this.child.kill()
  }
}
