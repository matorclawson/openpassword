# Replacement status

This is a working 0.1.0 candidate. Existing ZEOconnect deployments still have capabilities and wire contracts that this version does not fully implement. The names in the provider directory identify executable adapters. They do not establish method-for-method parity or vendor certification.

The comparison baselines are ZEOconnect b83b7f7ce30e10521cfdc4fa6e81352a3e771b04 and zeointegrations 4647f2cd9f79dbbcd168165d719f6ba1173f05f6. The inventories below describe the exported source. Unbuilt proposals in the reference integration backlog are separate from shipped Python functionality.

## Broker and console

| Area | Implemented and exercised | Remaining differences |
|---|---|---|
| Custody | AES-256-GCM data envelopes with per-write keys, wrapped by the installation key; record-bound authenticated data; restart and rotation; browser-sealed provider intake; separate human-readable vault items. | Local file key custody, one broker process and same-origin console proxy. The private deployment's separate database identities, managed key lifecycle and migration tools need equivalent Linux deployments. |
| Tenancy and identity | Owner, workspace-scoped editors and viewers, authenticated sessions, isolated grants and encrypted credentials. | Enterprise identity federation, upstream membership migration, browser delegation, SSH identity, certificates, runtime identity and service-specific trust chains. |
| Device transport | Version negotiation, single-use pairing, access and refresh rotation, revocation, connection discovery, operation capabilities, expected binding and durable idempotency. | Availability is a smaller projection. Capability, fence precedence and failure-marker compatibility still require the entire upstream conformance suite. The CLI's SQLite identity lock serializes local refreshes. |
| Approvals | Exact argument previews; replay after restart or pause; revocation; bounded standing Loops campaign creation. | Other reference standing draft operations, signed approval snapshots, their complete display/redaction fixtures, and signed connector updates. |
| Gmail | Actual golden response shape, digest and artifact bytes; selected-label page reads, continuation and expiring encrypted artifacts. | Complete upstream error classification, retry behavior, cross-version continuation encoding and all artifact expiry/retention edge cases. |
| Loops contact imports | Manifest, selected list, workflow checks, bounded digest-verified chunks, per-connection pacing, durable claims and replay; simulated import exercised end to end. | Full upstream negative-view suite, administrative reconciliation of interrupted claims, resume attestations, 429 retry scheduling and pacing shared with non-batch Loops calls. |
| YouTube | Approved video, thumbnail and caption upload sessions; device/connection/revision-bound and size-limited optional relay; links suppressed on replays. | Full client-side resumable transfer, upstream reconciliation, OAuth renewal qualification and live media evidence. |
| Models | Scoped chat grants for OpenAI-compatible endpoints, text SSE, quota reservation, exact model and token ceilings, duplicate suppression, audit and stop checks. | Monetary metering and settlement, image generation, provider failover, tool-call streams and provider-specific model lifecycle. |
| Operational controls | Pause, revoke, rotate, record actor and decision, persist execution outcome. | Complete per-service stop policies, escalation, reader databases, tenant-scoped retention/export and operational doubles. |
| Web experience | Responsive workspace, search, grant builder, operator review, vault items, team roles, catalog and audit log. | Migration of historical deployment data and full UI/AX acceptance against the operator's existing estate. |
| GitHub identity | API-token reads, scoped read-only installation-token exchange and fixed GitHub operations. | Installation keymaster, scoped GitHub App signing, PR-specific identity workflows and Annex A/B golden conformance. |

## Shipped integration families

The TypeScript registry is authoritative for exact callable operation IDs, arguments and fixed destinations. Each descriptor has a request-construction check. Only the workflows named in the test suite have end-to-end provider simulations.

| Reference family | Coverage in this release | Examples of remaining depth |
|---|---|---|
| Google Calendar, Docs, Drive, Gmail, Sheets, Slides, YouTube | Scoped HTTP operations, Google OAuth, selected Sheets resources, Gmail golden artifact and YouTube session/relay. | Full Drive content/permission workflows, Docs/Slides builders, multi-account consent lifecycle, all YouTube job recovery/retention. |
| GitHub, Reddit | Repository, release and listing operations; bounded source reads, content digest and transient-body replay behavior. | End-to-end GitHub installation lifecycle, precise read projection/error corpus and live qualification of application-only Reddit mint. |
| HubSpot, Kit, Loops | CRM/email reads and draft operations, subscriber projection, campaign creation and manifest-bound Loops imports. | Full draft/theme/template lifecycle, HubSpot bundle workflows, Kit sequence authoring, reviewed sending and state reconciliation. |
| Bluesky, Mastodon | Profiles, feeds, AT Protocol record creation and status publication. | Bluesky recovery/facets and discovery of arbitrary Mastodon instances. |
| Publishing | X, Threads, Facebook, Instagram and LinkedIn operations behind scoped grants and write approval. | Multi-stage uploads, X thread recovery, per-network publication reconciliation and the reference composition layer. |
| Telegram and Twilio/WhatsApp | Telegram updates, send and callbacks; Twilio message list/send; reusable Twilio webhook signature verification. | Full bot update object models, inbound event routing, media lifecycle and application gateway contracts. |
| Revolut Business | Read-only, selected account IDs, bounded transaction pages, exact decimal lexemes for money. | Complete regulated normalization, dedicated signing and refresh flows, expense/receipt/label coverage, provider venue qualification. |
| Supabase and Notion | Supabase project, selected-table reads/inserts; Notion pages, blocks and users. | Supabase realtime subscriptions, object storage, auth lifecycle; Notion OAuth, full upsert and file operations. |
| Briefing sources | Fixed weather, aircraft and exchange-rate request builders. | Reference-specific response projection, cache, budget and media-type coverage. |
| FFmpeg and Jupytext | Local typed media probe, H.264, audio and thumbnail helpers; percent-script and notebook conversion. | Rich metadata, strict semantic receipts, format variants and directory-level batch conversion. |
| Webhooks | Raw-byte Loops HMAC and Twilio URL/form verification, including negative signature tests. | Long-lived delivery deduplication, full event ingestion and provider retry handling. |

## Evidence required for replacement

Run `make verify` from a clean checkout. Qualify the Linux ARM64 service with real test tenants and separately authorize each live effect. Port the remaining legacy caller tests, including negative fixtures, to the public wire interface. Compare provider results, error markers, selected-resource restrictions, expiry and replay behavior before moving an existing consumer. No upstream provider calls, public deployment, production cutover or ARM64 machine qualification were performed in the council workspace.
