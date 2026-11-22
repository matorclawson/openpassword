import { z } from 'zod'
import { tariff } from './billing.ts'
export const modelLease = z
  .object({
    model: z.string().trim().min(1).max(200),
    tariff: tariff.optional(),
    calls: z.number().int().min(1).max(10000),
    max_tokens: z.number().int().min(1).max(32768),
  })
  .strict()
const fname = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  callId = z.string().min(1).max(200)
const call = z
  .object({
    id: callId,
    type: z.literal('function'),
    function: z.object({ name: fname, arguments: z.string().max(64000) }).strict(),
  })
  .strict()
const message = z.discriminatedUnion('role', [
  z
    .object({ role: z.enum(['system', 'user', 'developer']), content: z.string().max(64000) })
    .strict(),
  z
    .object({
      role: z.literal('assistant'),
      content: z.string().max(64000).nullable(),
      tool_calls: z.array(call).min(1).max(32).optional(),
    })
    .strict()
    .refine((m) => m.content !== null || !!m.tool_calls),
  z
    .object({ role: z.literal('tool'), tool_call_id: callId, content: z.string().max(64000) })
    .strict(),
])
const tool = z
  .object({
    type: z.literal('function'),
    function: z
      .object({
        name: fname,
        description: z.string().max(4000).optional(),
        parameters: z.record(z.string(), z.unknown()).optional(),
        strict: z.boolean().optional(),
      })
      .strict(),
  })
  .strict()
export const chat = z
  .object({
    model: z.string().min(1).max(200),
    messages: z.array(message).min(1).max(100),
    stream: z.boolean().default(false),
    max_tokens: z.number().int().positive(),
    temperature: z.number().min(0).max(2).optional(),
    tools: z
      .array(tool)
      .min(1)
      .max(32)
      .refine((ts) => new Set(ts.map((t) => t.function.name)).size === ts.length)
      .optional(),
    tool_choice: z
      .union([
        z.enum(['none', 'auto', 'required']),
        z
          .object({ type: z.literal('function'), function: z.object({ name: fname }).strict() })
          .strict(),
      ])
      .optional(),
    parallel_tool_calls: z.boolean().optional(),
  })
  .strict()
  .refine(
    (b) =>
      typeof b.tool_choice !== 'object' ||
      b.tools?.some(
        (t) => typeof b.tool_choice === 'object' && t.function.name === b.tool_choice.function.name,
      ),
  )
