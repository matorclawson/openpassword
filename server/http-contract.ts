// Public agent API. Keep request schemas for provider and model calls shared with their handlers.
import { z } from 'zod'
import { invocation, name } from '../packages/schemas/index.ts'
import { chat } from './models.ts'

const json = (schema: object) => ({ 'application/json': { schema } })
const schema = (value: z.ZodType) => {
  const { $schema, ...result } = z.toJSONSchema(value, { io: 'input' })
  return result
}
const object = { type: 'object' }
const text = z.string()
const itemList = z.array(text)
const binding = z.object({
  connection_id: text,
  external_identity: text,
  connection_revision: text,
  label: text,
})
const action = z.object({
  id: text,
  method: text,
  path: text,
  query: itemList,
  body: itemList,
  required: itemList,
  connector_revision: text,
  approval: text,
})
const capabilities = binding.extend({
  operations: z.array(action),
  resources: itemList,
  model_lease: z.object({ model: text, remaining: z.number(), max_tokens: z.number() }).nullable(),
})
const visibleConnection = binding.extend({
  connection_revision: text.optional(),
  provider: text,
  status: text,
  operations: itemList,
  resources: itemList,
})

const strings = (...keys: string[]) => ({
  type: 'object',
  required: keys,
  properties: Object.fromEntries(keys.map((k) => [k, { type: 'string' }])),
})
const tokenResponse = strings(
  'device_id',
  'access_token',
  'refresh_token',
  'access_expires_at',
  'refresh_expires_at',
)
const protocol = {
  in: 'header',
  name: 'OpenPassword-Protocol-Version',
  required: true,
  schema: { type: 'string', const: '1' },
}
const bound = [{ bearer: [], hostProof: [] }, { bearer: [] }]
const pairing = [{ hostProof: [] }, {}]
function endpoint(
  operationId: string,
  summary: string,
  options: {
    body?: object
    result?: object
    parameters?: object[]
    security?: object[]
    compatible?: boolean
    empty?: boolean
    pending?: boolean
    stream?: boolean
  } = {},
) {
  return {
    operationId,
    summary,
    security: options.security ?? bound,
    parameters: [...(options.compatible ? [] : [protocol]), ...(options.parameters ?? [])],
    ...(options.body ? { requestBody: { required: true, content: json(options.body) } } : {}),
    responses: {
      ...(options.empty
        ? { '204': { description: 'Grant revoked' } }
        : {
            '200': {
              description: 'Success',
              content: {
                ...json(options.result ?? object),
                ...(options.stream ? { 'text/event-stream': { schema: { type: 'string' } } } : {}),
              },
            },
          }),
      ...(options.pending
        ? { '428': { description: 'Awaiting approval. Poll at interval_seconds.' } }
        : {}),
      default: { description: 'Request refused or failed. See HTTP status and response body.' },
    },
  }
}
export const httpContract = {
  openapi: '3.1.0',
  info: {
    title: 'OpenPassword agent HTTP API',
    version: '1',
    description:
      'Core grant, credential operation and model routes. Host-bound grants require bearer AND host proof. Bearer alone is available only where standalone grants are authorized. All paths are relative to the broker origin.',
  },
  components: {
    securitySchemes: {
      bearer: {
        type: 'http',
        scheme: 'bearer',
        description: 'An OpenPassword agent access token.',
      },
      hostProof: {
        type: 'apiKey',
        in: 'header',
        name: 'OpenPassword-Host',
        description: 'Fresh per-request proof from the enrolled host signer.',
      },
    },
  },
  paths: {
    '/v1/vault/deposits': {
      post: endpoint('depositPrivateItem', 'Commit one owner-prepared encrypted item using its five-minute receipt', {
        security:[{}], body:schema(z.object({ticket:z.string().regex(/^[A-Za-z0-9_-]{43}$/)}).strict()),
        result:schema(z.object({saved:z.literal(true)}))
      })
    },
    '/v1/device/authorizations': {
      post: endpoint('pair', 'Request approval for an agent', {
        security: pairing,
        body: schema(z.object({ device_name: name })),
        result: schema(
          z.object({
            pairing_id: text,
            device_code: text,
            user_code: text,
            verification_url: text,
            expires_at: text,
            interval_seconds: z.number().int(),
          }),
        ),
      }),
    },
    '/v1/device/token': {
      post: endpoint('exchange', 'Exchange an approved device code', {
        security: pairing,
        pending: true,
        body: schema(z.object({ device_code: name })),
        result: tokenResponse,
      }),
    },
    '/v1/device/token/refresh': {
      post: endpoint('refresh', 'Rotate the token pair', {
        security: pairing,
        body: schema(z.object({ refresh_token: name })),
        result: tokenResponse,
      }),
    },
    '/v1/device/revoke': {
      post: endpoint('revoke', 'Revoke the authenticated grant', { empty: true }),
    },
    '/v1/whoami': {
      get: endpoint('whoami', 'Identify the authenticated agent', {
        result: schema(
          z.object({
            device_id: text,
            host_id: text.nullable(),
            label: text,
            workspace: text,
            connection_id: text,
            expires_at: text,
          }),
        ),
      }),
    },
    '/v1/session': {
      get: endpoint('session', 'Read token and grant expiry', {
        result: strings('device_id', 'access_expires_at', 'grant_expires_at', 'connection_id'),
      }),
    },
    '/v1/connections': {
      get: endpoint('connections', 'List connections visible to the grant', {
        result: schema(z.array(visibleConnection)),
      }),
    },
    '/v1/capabilities': {
      get: endpoint(
        'capabilities',
        'Discover operation IDs, connection revision, external identity and model lease',
        { result: schema(capabilities) },
      ),
    },
    '/v1/operations/{operation_id}:invoke': {
      post: endpoint('invoke', 'Invoke a granted provider operation', {
        body: schema(invocation),
        result: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            execution_id: { type: 'string' },
            result: {},
            receipt: object,
          },
        },
        parameters: [
          { in: 'path', name: 'operation_id', required: true, schema: { type: 'string' } },
          {
            in: 'header',
            name: 'OpenPassword-Capabilities',
            description: 'Send expected-binding when supplying expect.',
            schema: { type: 'string', const: 'expected-binding' },
          },
        ],
      }),
    },
    '/v1/models': {
      get: endpoint('models', 'List models available under the grant', {
        compatible: true,
        result: schema(
          z.object({
            object: z.literal('list'),
            data: z.array(z.object({ id: text, object: text, owned_by: text })),
          }),
        ),
      }),
    },
    '/v1/chat/completions': {
      post: endpoint('chat', 'Generate a completion with the model lease', {
        body: schema(chat),
        compatible: true,
        stream: true,
        parameters: [{ in: 'header', name: 'Idempotency-Key', schema: { type: 'string' } }],
      }),
    },
    '/v1/activity': {
      get: endpoint('activity', 'Read or long-poll this agent’s activity', {
        parameters: [
          { in: 'query', name: 'after', schema: { type: 'integer', minimum: 0 } },
          { in: 'query', name: 'wait', schema: { type: 'integer', minimum: 0, maximum: 20000 } },
        ],
        result: {
          type: 'object',
          required: ['cursor', 'events'],
          properties: { cursor: { type: 'integer' }, events: { type: 'array', items: object } },
        },
      }),
    },
  },
}
