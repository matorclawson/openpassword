import { z } from 'zod'
export const modelLease = z
  .object({
    model: z.string().trim().min(1).max(200),
    calls: z.number().int().min(1).max(10000),
    max_tokens: z.number().int().min(1).max(32768),
  })
  .strict()
export const chat = z
  .object({
    model: z.string().min(1).max(200),
    messages: z
      .array(
        z
          .object({
            role: z.enum(['system', 'user', 'assistant', 'developer']),
            content: z.string().max(64000),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    stream: z.boolean().default(false),
    max_tokens: z.number().int().positive(),
    temperature: z.number().min(0).max(2).optional(),
  })
  .strict()
