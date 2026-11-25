import { LocalAgent } from '@openpassword/client/local'
const agent = new LocalAgent()
console.log(await agent.whoami())
console.log(await agent.capabilities())

if (process.env.OPENPASSWORD_REQUEST_KEY) {
  const result = await agent.operation('github.user.get', {}, process.env.OPENPASSWORD_REQUEST_KEY)
  console.log(result)
}
