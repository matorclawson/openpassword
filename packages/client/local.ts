import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'

export class LocalAgent {
  readonly executable: string
  constructor(executable = process.env.OPENPASSWORD_ADAPTER) {
    if (!executable || !isAbsolute(executable))
      throw Error('Set OPENPASSWORD_ADAPTER to the absolute prepared executable')
    this.executable = executable
  }
  private call(args: string[], input = ''): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        this.executable,
        args,
        { timeout: 120000, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) return reject(Error(stderr.trim() || 'OpenPassword CLI failed'))
          try {
            resolve(JSON.parse(stdout))
          } catch {
            reject(Error('Invalid CLI response'))
          }
        },
      )
      child.stdin!.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code !== 'EPIPE') reject(err)
      })
      child.stdin!.end(input)
    })
  }
  whoami() {
    return this.call(['whoami'])
  }
  capabilities() {
    return this.call(['capabilities'])
  }
  models() {
    return this.call(['models'])
  }
  chat(model: string, prompt: string, maxTokens: number, requestKey: string) {
    return this.call(['chat', model, String(maxTokens), requestKey], prompt)
  }
  operation(operationId: string, args: Record<string, unknown>, requestKey: string) {
    return this.call(['operation', operationId, requestKey], JSON.stringify(args))
  }
  invoke(
    connectionId: string,
    operationId: string,
    args: Record<string, unknown>,
    requestKey: string,
    expect?: { external_identity: string; connection_revision: string },
  ) {
    return this.call(
      ['invoke-json'],
      JSON.stringify({
        connection_id: connectionId,
        operation_id: operationId,
        arguments: args,
        idempotency_key: requestKey,
        expect,
      }),
    )
  }
}
