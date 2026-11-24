// Run with the service stopped, as the broker identity.
import { wrapExistingMaster } from '../server/store.ts'
const dir = process.env.OPENPASSWORD_HOME
const key = process.env.OPENPASSWORD_WRAPPING_KEY_FILE
if (!dir || !key) throw Error('Set OPENPASSWORD_HOME and OPENPASSWORD_WRAPPING_KEY_FILE')
wrapExistingMaster(dir, key)
console.log('Verified wrapped master key')
