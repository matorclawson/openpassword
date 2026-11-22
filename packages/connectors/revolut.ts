import { z } from 'zod'
const uuid = z.string().regex(/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i)
const date = z.iso.datetime({ offset: true }),
  text = z.string().max(2000),
  currency = z.string().regex(/^[A-Z]{3}$/),
  word = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)
const exact = z.string().regex(/^-?\d+(\.\d+)?$/)
const optional = <T extends z.ZodType>(v: T) => v.nullish().transform((x) => x ?? null)
const merchant = z.object({
  id: optional(uuid),
  name: optional(text),
  full_name: optional(text),
  city: optional(text),
  category_code: optional(text),
  country: optional(text),
})
const counterparty = z.object({
  id: optional(uuid),
  account_id: optional(uuid),
  account_type: optional(word),
})
const leg = z.object({
  leg_id: uuid,
  account_id: uuid,
  amount: exact,
  currency,
  fee: optional(exact),
  bill_amount: optional(exact),
  bill_currency: optional(currency),
  balance: optional(exact),
  counterparty: optional(counterparty),
  description: optional(text),
})
const tx = z.object({
  id: z.string().min(1).max(100),
  type: word,
  state: word,
  created_at: date,
  updated_at: date,
  completed_at: optional(date),
  scheduled_for: optional(z.iso.date()),
  request_id: optional(text),
  reason_code: optional(text),
  related_transaction_id: optional(uuid),
  reference: optional(text),
  merchant: optional(merchant),
  card: optional(z.object({ id: optional(uuid) })),
  legs: z.array(leg),
})
const acct = z.object({
  id: uuid,
  name: optional(text),
  balance: exact,
  currency,
  state: word,
  public: z.boolean(),
  account_type: optional(word),
  created_at: date,
  updated_at: date,
})
export const revolutQuery = z
  .object({
    account_id: uuid,
    from: date.optional(),
    to: date.optional(),
    count: z.number().int().min(1).max(1000).default(100),
    type: word.optional(),
  })
  .strict()
  .refine((q) => !q.from || !q.to || Date.parse(q.from) < Date.parse(q.to))
function bounded<T>(v: T) {
  if (Buffer.byteLength(JSON.stringify(v)) > 768 * 1024) throw Error('Revolut result too large')
  return v
}
export const revolutAccounts = (data: unknown) => bounded({ accounts: z.array(acct).parse(data) })
export function revolutTransactions(data: unknown, args: Record<string, unknown>) {
  const q = revolutQuery.parse(args),
    transactions = z.array(tx).max(q.count).parse(data)
  if (transactions.some((t) => !t.legs.some((l) => l.account_id === q.account_id)))
    throw Error('Transaction outside selected account')
  const dates = transactions.map((t) => t.created_at).sort((a, b) => Date.parse(a) - Date.parse(b))
  const next_to = transactions.length >= q.count ? dates[0] : null
  if (next_to && q.to && Date.parse(next_to) >= Date.parse(q.to)) throw Error('Pagination stalled')
  return bounded({
    transactions,
    observed_at: new Date().toISOString(),
    next_to,
    normalization_version: 'revolut-business-read-1',
  })
}
const pid = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)
const money = z.object({ amount: exact, currency })
const category = z.object({ id: pid, name: text, code: optional(text) })
const split = z.object({
  amount: z.object({ amount: optional(exact), currency: optional(currency) }),
  category: optional(category),
  tax_rate: optional(z.object({ id: pid, name: text, percentage: optional(exact) })),
})
const labels = z.record(text, z.array(text).length(1)).refine((v) => Object.keys(v).length <= 5)
const expense = z.object({
  id: pid,
  state: word,
  transaction_type: word,
  expense_date: date,
  submitted_at: optional(date),
  completed_at: optional(date),
  merchant: optional(text),
  transaction_id: optional(pid),
  labels,
  splits: z.array(split),
  receipt_ids: z.array(pid),
  spent_amount: money,
})
const pageToken = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[A-Za-z0-9+/=_-]+$/)
export const expenseQuery = z
  .object({
    from: date.optional(),
    to: date.optional(),
    state: word.optional(),
    transaction_type: word.optional(),
    count: z.number().int().min(1).max(500).default(100),
  })
  .strict()
  .refine((q) => !q.from || !q.to || Date.parse(q.from) < Date.parse(q.to))
export const labelQuery = z
  .object({
    limit: z.number().int().min(1).max(500).default(100),
    page_token: pageToken.optional(),
    group_id: pid.optional(),
  })
  .strict()
const label = z.object({ id: uuid, name: text, created_at: date, updated_at: date })
export function expenseResult(op: string, data: unknown, args: Record<string, unknown>) {
  if (op === 'revolut.expenses.get') {
    const e = expense.parse(data)
    if (e.id !== args.expense_id) throw Error('Expense identity changed')
    return bounded(e)
  }
  const observed_at = new Date().toISOString()
  if (op === 'revolut.expenses.list') {
    const q = expenseQuery.parse(args),
      expenses = z.array(expense).max(q.count).parse(data),
      next_to =
        expenses.length >= q.count
          ? expenses.map((e) => e.expense_date).sort((a, b) => Date.parse(a) - Date.parse(b))[0]
          : null
    if (next_to && q.to && Date.parse(next_to) >= Date.parse(q.to))
      throw Error('Pagination stalled')
    return bounded({
      expenses,
      next_to,
      observed_at,
      completeness: 'unverified',
      normalization_version: 'revolut-business-read-1',
    })
  }
  const key = op === 'revolut.labels.list' ? 'labels' : 'label_groups',
    q = labelQuery.parse(args)
  const d = z
    .object({ [key]: z.array(label).max(q.limit), next_page_token: pageToken.nullish() })
    .parse(data) as Record<string, unknown>
  if (q.page_token && q.page_token === d.next_page_token) throw Error('Pagination stalled')
  return bounded({ ...d, next_page_token: d.next_page_token ?? null, observed_at })
}
