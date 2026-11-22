import { service } from './service.ts'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
process.umask(0o077)
const dir = resolve(process.env.OPENPASSWORD_HOME || homedir() + '/.openpassword')
const api = service(dir, process.env.OPENPASSWORD_WEB_ORIGIN || 'http://localhost:3000')
await api.listen({ host: '127.0.0.1', port: Number(process.env.OPENPASSWORD_PORT || 4141) })
console.log(
  'OpenPassword broker is listening. For first-time setup, read the setup code on this host from ' +
    dir +
    '/operator.token',
)
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void api.close())
