// Voice cloning and conversion are separate operations, off by default (openpassword-SOW-04).
// Creating or using a cloned voice is an impersonation risk, so a grant that carries such an
// operation needs a recorded approval by a human workspace owner in the console, never by an
// agent or an API grant, and a vendor that documents a consent mechanism.

//
// Trusted binding (required before any caller uses cloningDecision): this helper checks only the shape of
// the approval. The caller must build `approval` from a server-side record that the workspace owner created
// in the console for this exact operation and grant (approver identity from the owner's console session,
// never from request data; `consent_ref` pointing at the stored consent record for the voice), and must
// refuse a record whose operation, workspace or grant differs from the one being authorized.
const CLONING = /(^|\.)voice\.(clone|convert|design)(\.|$)/

export function isCloningOperation(op: string): boolean {
  return typeof op === 'string' && CLONING.test(op)
}

export interface CloningApproval {
  approver: string
  role: string
  method: string
  consent_ref: string
  at: number
}
export type CloningDecision =
  | { ok: true; cloning: boolean }
  | { ok: false; code: 'cloning_approval_required' | 'cloning_vendor_unsupported' }

export function cloningDecision(input: {
  operations: string[]
  approval?: CloningApproval | null
  /** The vendor descriptor says the vendor documents a consent mechanism. */
  vendorConsent: boolean
}): CloningDecision {
  if (!input.operations.some(isCloningOperation)) return { ok: true, cloning: false }
  if (!input.vendorConsent) return { ok: false, code: 'cloning_vendor_unsupported' }
  const a = input.approval
  if (
    !a ||
    a.role !== 'owner' ||
    a.method !== 'console' ||
    typeof a.approver !== 'string' ||
    a.approver.length === 0 ||
    typeof a.consent_ref !== 'string' ||
    a.consent_ref.trim().length < 3 ||
    !Number.isFinite(a.at)
  )
    return { ok: false, code: 'cloning_approval_required' }
  return { ok: true, cloning: true }
}
