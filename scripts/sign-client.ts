// Gate operator on the signing machine; no sudo. Input key stays outside the release tree.
import { createPrivateKey, sign } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
const [pem, client, output] = process.argv.slice(2)
if (!pem || !client || !output)
  throw Error('Usage: sign-client.ts KEY_FILE CLI_FILE SIGNATURE_FILE')
const key = createPrivateKey(readFileSync(pem))
if (key.asymmetricKeyType !== 'ed25519') throw Error('An Ed25519 release key is required')
writeFileSync(output, sign(null, readFileSync(client), key), { flag: 'wx' })
