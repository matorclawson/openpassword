export function ApprovalPreview({ value }: { value: unknown }) {
  const object = value as {
    snapshot?: {
      schema: string
      render?: { html: string; reason: string }
      limits?: { truncated: boolean }
    }
    snapshot_digest?: string
  }
  if (
    value &&
    typeof value === 'object' &&
    'schema' in value &&
    value.schema === 'hubspot-issue/1'
  ) {
    const issue = value as {
      schema: string
      folder: string
      bundle_sha256: string
      files: { file_name: string; content_type: string; size_bytes: number }[]
      template_files: { path: string }[]
      update_draft?: unknown
    }
    return (
      <section>
        <strong>Publish issue assets</strong>
        <p>Files uploaded to {issue.folder} will be publicly accessible by URL.</p>
        <ul>
          {issue.files.map((f) => (
            <li key={f.file_name}>
              {f.file_name} · {f.content_type} · {f.size_bytes.toLocaleString()} bytes
            </li>
          ))}
        </ul>
        {issue.template_files.map((f) => (
          <p key={f.path}>Update draft template {f.path}</p>
        ))}
        {issue.update_draft ? <p>Update the linked newsletter draft</p> : null}
        <details>
          <summary>Review exact manifest and digest</summary>
          <pre>{JSON.stringify(value, null, 2)}</pre>
        </details>
      </section>
    )
  }
  const s = object?.snapshot
  if (s?.schema !== 'approval-snapshot/1' || typeof s.render?.html !== 'string')
    return <pre>{JSON.stringify(value, null, 2)}</pre>
  return (
    <section>
      <p>
        <strong>Partial preview</strong>
        {s.limits?.truncated ? ' · Content shortened to fit' : ''}
      </p>
      <iframe
        sandbox=""
        referrerPolicy="no-referrer"
        title="Draft approval preview"
        style={{ width: '100%', minHeight: 180, border: '1px solid #bcb4a8', background: 'white' }}
        srcDoc={
          '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src ' +
          "'none'" +
          '">' +
          s.render.html
        }
      />
      <details>
        <summary>Approval details and digest</summary>
        <pre>
          {JSON.stringify(
            { ...s, render: undefined, snapshot_digest: object.snapshot_digest },
            null,
            2,
          )}
        </pre>
      </details>
    </section>
  )
}
