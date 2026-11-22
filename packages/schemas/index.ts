import { z } from 'zod'
export const name = z.string().trim().min(1).max(200)
export const connectionInput = z
  .object({
    expires_at: z.number().int().positive().max(8640000000000000).nullable().optional(),
    ownership: z.enum(['organization', 'personal']).optional(),
    provider: name,
    resources: z.array(name).max(100).optional(),
    label: name,
    external_identity: z.string().trim().min(1).max(500),
    secret: z.string().min(1).max(32768),
  })
  .strict()
export const invocation = z
  .object({
    connection_id: name,
    operation_id: name,
    connector_revision: z.string().nullable().optional(),
    arguments: z.record(z.string(), z.unknown()),
    idempotency_key: name,
    expect: z
      .object({
        external_identity: z.string().min(1).max(500),
        connection_revision: z.string().regex(/^[1-9][0-9]{0,18}$/),
      })
      .strict()
      .optional(),
  })
  .strict()
export type Invocation = z.infer<typeof invocation>
