// SPDX-License-Identifier: MIT
// Supply a device token through your application's identity store.
import { OpenPassword } from '@openpassword/client'

export async function readGitHubIdentity(
  origin: string,
  deviceToken: string,
  connection: { connection_id: string; external_identity: string; connection_revision: string },
  taskKey: string,
) {
  const broker = new OpenPassword(origin, deviceToken)
  return broker.invoke(connection.connection_id, 'github.user.get', {}, taskKey, {
    external_identity: connection.external_identity,
    connection_revision: connection.connection_revision,
  })
}
