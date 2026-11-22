import { sheetsRequest } from './sheets.js'
export { sheetsResult } from './sheets.js'
// Fixed provider routes. Callers supply values only for declared fields.
export type Action = {
  id: string
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  path: string
  query: string[]
  body: string[]
  required: string[]
}
export type Provider = { name: string; group: string; origin: string; actions: Action[] }
function action(
  id: string,
  path: string,
  query = '',
  method: Action['method'] = 'GET',
  body = '',
  required = '',
): Action {
  const fields = (value: string) => value.split(' ').filter(Boolean)
  return { id, method, path, query: fields(query), body: fields(body), required: fields(required) }
}
function provider(name: string, group: string, origin: string, ...actions: Action[]): Provider {
  return { name, group, origin, actions }
}
export const providers: Record<string, Provider> = {
  google_workspace: provider(
    'Google Workspace',
    'Productivity',
    'https://www.googleapis.com',
    action(
      'google.gmail.messages.read_page',
      '/gmail/v1/users/me/messages',
      'label_id starts_at ends_at cursor page_size maximum_bytes',
    ),
    action('google.gmail.labels.list', '/gmail/v1/users/me/labels'),
    action(
      'google.gmail.messages.list',
      '/gmail/v1/users/me/messages',
      'pageToken maxResults labelIds q',
    ),
    action('google.gmail.messages.get', '/gmail/v1/users/me/messages/{id}', 'format'),
    action(
      'google.calendar.events.list',
      '/calendar/v3/calendars/{calendar}/events',
      'pageToken timeMin timeMax',
    ),
    action('google.drive.files.list', '/drive/v3/files', 'q fields pageSize pageToken'),
    action('google.drive.files.get', '/drive/v3/files/{id}', 'fields'),
    action('google.docs.get', 'https://docs.googleapis.com/v1/documents/{id}'),
    action('google.slides.get', 'https://slides.googleapis.com/v1/presentations/{id}'),
    action(
      'google.sheets.values.get',
      'https://sheets.googleapis.com/v4/spreadsheets/{id}/values/{range}',
    ),
    action(
      'google.sheets.values.update',
      'https://sheets.googleapis.com/v4/spreadsheets/{id}/values/{range}',
      'valueInputOption',
      'PUT',
      'values',
      'valueInputOption values',
    ),
    action(
      'google.youtube.channels.list',
      '/youtube/v3/channels',
      'part mine id',
      'GET',
      '',
      'part',
    ),
    action('google.youtube.videos.list', '/youtube/v3/videos', 'part id', 'GET', '', 'part id'),
  ),
  github_read: provider(
    'GitHub',
    'Developer tools',
    'https://api.github.com',
    action('github.user.get', '/user'),
    action('github.repos.list', '/user/repos', 'page per_page'),
    action('github.issues.list', '/repos/{owner}/{repo}/issues', 'state page'),
    action('github.pulls.get', '/repos/{owner}/{repo}/pulls/{number}'),
  ),
  notion: provider(
    'Notion',
    'Productivity',
    'https://api.notion.com',
    action('notion.pages.get', '/v1/pages/{id}'),
    action('notion.blocks.children', '/v1/blocks/{id}/children', 'page_size start_cursor'),
  ),
  loops: provider(
    'Loops',
    'Marketing',
    'https://app.loops.so',
    action('loops.lists.list', '/api/v1/lists'),
    action('loops.fields.list', '/api/v1/contacts/properties'),
    action('loops.contacts.find', '/api/v1/contacts/find', 'email userId'),
  ),
  kit: provider(
    'Kit',
    'Marketing',
    'https://api.kit.com',
    action('kit.subscribers.list', '/v4/subscribers', 'after before per_page'),
    action('kit.broadcasts.get', '/v4/broadcasts/{id}'),
    action(
      'kit.broadcasts.create',
      '/v4/broadcasts',
      '',
      'POST',
      'subject content',
      'subject content',
    ),
  ),
  hubspot: provider(
    'HubSpot',
    'Marketing',
    'https://api.hubapi.com',
    action('hubspot.contacts.list', '/crm/v3/objects/contacts', 'limit after properties'),
    action('hubspot.emails.get', '/marketing/v3/emails/{id}'),
  ),
  telegram: provider(
    'Telegram',
    'Messaging',
    'https://api.telegram.org',
    action('telegram.bot.get', '/bot~token/getMe'),
    action('telegram.updates', '/bot~token/getUpdates', 'offset limit'),
    action(
      'telegram.send',
      '/bot~token/sendMessage',
      '',
      'POST',
      'chat_id text reply_markup',
      'chat_id text',
    ),
    action(
      'telegram.callback.answer',
      '/bot~token/answerCallbackQuery',
      '',
      'POST',
      'callback_query_id text',
      'callback_query_id',
    ),
  ),
  twilio: provider(
    'Twilio / WhatsApp',
    'Messaging',
    'https://api.twilio.com',
    action('twilio.messages.list', '/2010-04-01/Accounts/~account/Messages.json', 'PageSize'),
    action(
      'twilio.messages.send',
      '/2010-04-01/Accounts/~account/Messages.json',
      '',
      'POST',
      'To From Body',
      'To From Body',
    ),
  ),
  bluesky: provider(
    'Bluesky',
    'Publishing',
    'https://bsky.social',
    action('bluesky.profile', '/xrpc/app.bsky.actor.getProfile', 'actor', 'GET', '', 'actor'),
    action('bluesky.timeline', '/xrpc/app.bsky.feed.getTimeline', 'limit cursor'),
  ),
  mastodon: provider(
    'Mastodon.social',
    'Publishing',
    'https://mastodon.social',
    action('mastodon.account', '/api/v1/accounts/verify_credentials'),
    action('mastodon.publish', '/api/v1/statuses', '', 'POST', 'status visibility', 'status'),
  ),
  x: provider(
    'X',
    'Publishing',
    'https://api.x.com',
    action('x.me', '/2/users/me'),
    action('x.publish', '/2/tweets', '', 'POST', 'text reply', 'text'),
  ),
  linkedin: provider(
    'LinkedIn',
    'Publishing',
    'https://api.linkedin.com',
    action('linkedin.me', '/v2/userinfo'),
  ),
  instagram: provider(
    'Instagram',
    'Publishing',
    'https://graph.facebook.com',
    action('instagram.media', '/v22.0/{id}/media', 'fields after'),
    action(
      'instagram.publish',
      '/v22.0/{id}/media_publish',
      '',
      'POST',
      'creation_id',
      'creation_id',
    ),
  ),
  facebook: provider(
    'Facebook',
    'Publishing',
    'https://graph.facebook.com',
    action('facebook.pages', '/v22.0/me/accounts', 'fields'),
    action('facebook.post', '/v22.0/{id}/feed', '', 'POST', 'message', 'message'),
  ),
  threads: provider(
    'Threads',
    'Publishing',
    'https://graph.threads.net',
    action('threads.profile', '/v1.0/me', 'fields'),
    action(
      'threads.publish',
      '/v1.0/{id}/threads_publish',
      '',
      'POST',
      'creation_id',
      'creation_id',
    ),
  ),
  revolut: provider(
    'Revolut Business',
    'Finance',
    'https://b2b.revolut.com',
    action('revolut.accounts.read', '/api/1.0/accounts'),
    action('revolut.transactions.list', '/api/1.0/transactions', 'from to count'),
  ),
  supabase: provider(
    'Supabase',
    'Developer tools',
    'https://api.supabase.com',
    action('supabase.projects', '/v1/projects'),
  ),
  reddit_read: provider(
    'Reddit',
    'Publishing',
    'https://oauth.reddit.com',
    action('reddit.posts', '/r/{subreddit}/new', 'limit after'),
  ),
  briefing_sources: provider(
    'Briefing sources',
    'Research',
    'https://api.met.no',
    action(
      'briefing.weather',
      '/weatherapi/locationforecast/2.0/compact',
      'lat lon',
      'GET',
      '',
      'lat lon',
    ),
    action('briefing.aircraft', 'https://api.adsb.lol/v2/hex/{hex}'),
    action(
      'briefing.rates',
      'https://data-api.ecb.europa.eu/service/data/EXR/{series}',
      'format startPeriod endPeriod',
    ),
  ),
  ...Object.fromEntries(
    [
      ['openai', 'OpenAI', 'https://api.openai.com/v1'],
      ['openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1'],
      ['moonshot', 'Moonshot', 'https://api.moonshot.ai/v1'],
    ].map(([id, name, origin]) => [
      id,
      provider(
        name,
        'Model providers',
        origin,
        action(id + '.models', '/models'),
        action(
          id + '.chat',
          '/chat/completions',
          '',
          'POST',
          'model messages temperature max_tokens',
          'model messages',
        ),
      ),
    ]),
  ),
}
providers.google_sheets = provider(
  'Google Sheets',
  'Productivity',
  'https://sheets.googleapis.com',
  action('sheets.read_range', '/v4/spreadsheets/{spreadsheet_id}/values/{range}'),
  action(
    'sheets.batch_get',
    '/v4/spreadsheets/{spreadsheet_id}/values:batchGet',
    'ranges',
    'GET',
    '',
    'ranges',
  ),
  action(
    'sheets.append_rows',
    '/v4/spreadsheets/{spreadsheet_id}/values/{range}:append',
    '',
    'POST',
    'rows',
    'rows',
  ),
  action(
    'sheets.update_range',
    '/v4/spreadsheets/{spreadsheet_id}/values/{range}',
    '',
    'PUT',
    'values',
    'values',
  ),
)
providers.supabase_data = provider(
  'Supabase Database',
  'Developer tools',
  'https://supabase.com',
  action('supabase.rows.read', '/rest/v1/{table}', 'select limit offset order'),
  action('supabase.rows.insert', '/rest/v1/{table}', '', 'POST', 'row', 'row'),
)
// Additional fixed routes share the same scope and approval enforcement.
providers.google_workspace.actions.push(
  action(
    'youtube.video.upload_session.create',
    '/upload/youtube/v3/videos',
    '',
    'POST',
    'size_bytes content_sha256 mime_type metadata status notify_subscribers',
    'size_bytes content_sha256 mime_type metadata status',
  ),
  action(
    'youtube.thumbnail.upload_session.create',
    '/upload/youtube/v3/thumbnails/set',
    '',
    'POST',
    'video_id size_bytes content_sha256 mime_type',
    'video_id size_bytes content_sha256 mime_type',
  ),
  action(
    'youtube.caption.upload_session.create',
    '/upload/youtube/v3/captions',
    '',
    'POST',
    'video_id size_bytes content_sha256 mime_type name language',
    'video_id size_bytes content_sha256 mime_type language',
  ),
  action('google.drive.permissions.list', '/drive/v3/files/{id}/permissions', 'pageToken fields'),
  action(
    'google.drive.comments.list',
    '/drive/v3/files/{id}/comments',
    'pageToken fields',
    'GET',
    '',
    'fields',
  ),
  action(
    'google.drive.folder.create',
    '/drive/v3/files',
    '',
    'POST',
    'name mimeType parents',
    'name mimeType',
  ),
  action('google.calendar.events.get', '/calendar/v3/calendars/{calendar}/events/{id}'),
  action(
    'google.calendar.events.create',
    '/calendar/v3/calendars/{calendar}/events',
    '',
    'POST',
    'summary description start end attendees',
    'summary start end',
  ),
  action(
    'google.docs.batch_update',
    'https://docs.googleapis.com/v1/documents/{id}:batchUpdate',
    '',
    'POST',
    'requests writeControl',
    'requests',
  ),
  action(
    'google.slides.batch_update',
    'https://slides.googleapis.com/v1/presentations/{id}:batchUpdate',
    '',
    'POST',
    'requests writeControl',
    'requests',
  ),
  action(
    'google.sheets.get',
    'https://sheets.googleapis.com/v4/spreadsheets/{id}',
    'fields includeGridData',
  ),
  action(
    'google.sheets.batch_update',
    'https://sheets.googleapis.com/v4/spreadsheets/{id}:batchUpdate',
    '',
    'POST',
    'requests',
    'requests',
  ),
  action(
    'google.gmail.attachments.get',
    '/gmail/v1/users/me/messages/{id}/attachments/{attachment}',
  ),
  action(
    'google.youtube.playlists.list',
    '/youtube/v3/playlists',
    'part mine id maxResults pageToken',
    'GET',
    '',
    'part',
  ),
  action(
    'google.youtube.playlist_items.list',
    '/youtube/v3/playlistItems',
    'part playlistId pageToken',
    'GET',
    '',
    'part playlistId',
  ),
  action(
    'google.youtube.video.update',
    '/youtube/v3/videos',
    'part',
    'PUT',
    'id snippet status',
    'part id',
  ),
  action(
    'google.youtube.playlist_items.insert',
    '/youtube/v3/playlistItems',
    'part',
    'POST',
    'snippet',
    'part snippet',
  ),
)
providers.reddit_read.actions.push(
  action('reddit.subreddit.new', '/r/{subreddit}/new', 'limit after'),
)
providers.github_read.actions.push(
  action(
    'github.repos.search',
    '/search/repositories',
    'q sort order per_page page',
    'GET',
    '',
    'q',
  ),
  action('github.repo.get', '/repos/{owner}/{repo}'),
  action('github.releases.list', '/repos/{owner}/{repo}/releases', 'per_page page'),
  action('github.release.latest', '/repos/{owner}/{repo}/releases/latest'),
  action('github.readme.get', '/repos/{owner}/{repo}/readme', 'ref'),
  action('github.repos.get', '/repos/{owner}/{repo}'),
  action('github.users.get', '/users/{login}'),
  action('github.pulls.list', '/repos/{owner}/{repo}/pulls', 'state page per_page'),
  action('github.issues.get', '/repos/{owner}/{repo}/issues/{number}'),
)
providers.notion.actions.push(
  action('notion.users.list', '/v1/users', 'start_cursor page_size'),
  action(
    'notion.pages.create',
    '/v1/pages',
    '',
    'POST',
    'parent properties children',
    'parent properties',
  ),
  action('notion.pages.update', '/v1/pages/{id}', '', 'PATCH', 'properties archived'),
  action('notion.blocks.append', '/v1/blocks/{id}/children', '', 'PATCH', 'children', 'children'),
)
providers.loops.actions.push(
  action(
    'loops.contacts.import_chunk',
    '/api/v1/contacts/update',
    '',
    'PUT',
    'manifest batch_id index rows',
  ),
  action('loops.contacts.inspect_batch', '/api/v1/contacts', 'batch_id'),
  action('loops.newsletter.inspect_account', '/api/v1/api-key'),
  action('loops.newsletter.get_campaign', '/api/v1/campaigns/{campaign_id}'),
  action('loops.newsletter.get_email_message', '/api/v1/email-messages/{email_message_id}'),
  action('loops.newsletter.list_themes', '/api/v1/themes'),
  action('loops.newsletter.list_mailing_lists', '/api/v1/lists'),
  action('loops.newsletter.create_campaign', '/api/v1/campaigns', '', 'POST', 'name', 'name'),
  action('loops.account.get', '/api/v1/api-key'),
  action('loops.themes.list', '/api/v1/themes', 'cursor'),
  action('loops.campaigns.create', '/api/v1/campaigns', '', 'POST', 'name', 'name'),
  action('loops.campaigns.get', '/api/v1/campaigns/{id}'),
  action('loops.emails.get', '/api/v1/email-messages/{id}'),
  action(
    'loops.emails.update',
    '/api/v1/email-messages/{id}',
    '',
    'POST',
    'expectedRevisionId subject previewText fromName fromEmail lmx',
    'expectedRevisionId',
  ),
)
providers.revolut.actions = [
  action('revolut.business.accounts.list', '/api/1.0/accounts'),
  action(
    'revolut.business.transactions.read_page',
    '/api/1.0/transactions',
    'account_id from to count type',
    'GET',
    '',
    'account_id',
  ),
]
providers.kit.actions.push(
  action('kit.subscribers.read_page', '/v4/subscribers', 'after per_page'),
  action('kit.account.get', '/v4/account'),
  action('kit.account.metrics', '/v4/account/email_stats'),
  action('kit.broadcasts.list', '/v4/broadcasts', 'after before per_page'),
  action('kit.broadcasts.metrics', '/v4/broadcasts/{id}/stats'),
  action('kit.broadcasts.clicks', '/v4/broadcasts/{id}/clicks'),
  action('kit.templates.list', '/v4/email_templates', 'after before per_page'),
  action('kit.segments.list', '/v4/segments', 'after before per_page'),
  action('kit.sequences.list', '/v4/sequences', 'after before per_page include'),
  action('kit.sequences.get', '/v4/sequences/{id}', 'include'),
  action('kit.sequence_emails.list', '/v4/sequences/{id}/emails', 'after before include_content'),
  action('kit.sequence_emails.get', '/v4/sequences/{id}/emails/{email}'),
)
providers.hubspot.actions.push(
  action('hubspot.emails.list', '/marketing/v3/emails', 'limit after'),
  action(
    'hubspot.emails.create',
    '/marketing/v3/emails',
    '',
    'POST',
    'name subject subscriptionDetails content',
    'name',
  ),
  action('hubspot.emails.update', '/marketing/v3/emails/{id}', '', 'PATCH', 'name subject content'),
  action('hubspot.files.get', '/files/v3/files/{id}'),
)
providers.bluesky.actions.push(
  action(
    'bluesky.feed',
    '/xrpc/app.bsky.feed.getAuthorFeed',
    'actor cursor limit',
    'GET',
    '',
    'actor',
  ),
  action(
    'bluesky.post',
    '/xrpc/com.atproto.repo.createRecord',
    '',
    'POST',
    'repo collection record rkey',
    'repo collection record',
  ),
)
providers.threads.actions.push(
  action('threads.posts.list', '/v1.0/{id}/threads', 'fields after limit'),
  action(
    'threads.draft',
    '/v1.0/{id}/threads',
    '',
    'POST',
    'media_type text image_url video_url',
    'media_type',
  ),
)
providers.instagram.actions.push(
  action(
    'instagram.media.create',
    '/v22.0/{id}/media',
    '',
    'POST',
    'image_url video_url caption media_type',
  ),
)
providers.linkedin.actions.push(
  action(
    'linkedin.post',
    '/rest/posts',
    '',
    'POST',
    'author commentary visibility distribution lifecycleState',
    'author commentary visibility distribution lifecycleState',
  ),
)
providers.mastodon.actions.push(
  action('mastodon.status.get', '/api/v1/statuses/{id}'),
  action('mastodon.instance', '/api/v2/instance'),
)
providers.x.actions.push(
  action('x.post.get', '/2/tweets/{id}', 'expansions'),
  action('x.user.posts', '/2/users/{id}/tweets', 'pagination_token max_results'),
)
export function buildRequest(
  providerId: string,
  operation: string,
  args: Record<string, unknown>,
  secret: string,
) {
  const p = providers[providerId],
    a = p?.actions.find((x) => x.id === operation)
  if (providerId === 'google_sheets' && a) return sheetsRequest(operation, args, secret)
  if (!a) throw Error('Unknown operation')
  const params = Array.from(a.path.matchAll(/\{(\w+)\}/g), (m) => m[1])
  const allowed = new Set([...params, ...a.query, ...a.body])
  if (
    Object.keys(args).some((k) => !allowed.has(k)) ||
    [...params, ...a.required].some((k) => args[k] == null)
  )
    throw Error('Invalid arguments')
  let path = a.path.replace(/\{(\w+)\}/g, (_, k) => {
    const v = args[k]
    if (
      (typeof v !== 'string' && typeof v !== 'number') ||
      !String(v) ||
      /[/\\\x00-\x1f]/.test(String(v)) ||
      ['.', '..'].includes(String(v))
    )
      throw Error('Invalid path field')
    return encodeURIComponent(String(v))
  })
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'OpenPassword/0.1',
  }
  if (providerId === 'telegram') path = path.replace('~token', encodeURIComponent(secret))
  else if (providerId === 'twilio') {
    const [account, token] = secret.split(':')
    if (!/^AC[0-9a-f]{32}$/i.test(account) || !token) throw Error('Invalid Twilio credential')
    path = path.replace('~account', account)
    headers.Authorization = 'Basic ' + Buffer.from(account + ':' + token).toString('base64')
  } else if (providerId === 'kit') headers['X-Kit-Api-Key'] = secret
  else if (providerId !== 'briefing_sources') headers.Authorization = 'Bearer ' + secret
  if (providerId === 'notion') headers['Notion-Version'] = '2022-06-28'
  let origin = p.origin
  if (providerId === 'supabase_data') {
    const auth = JSON.parse(secret)
    if (
      !/^[a-z0-9]{20}$/.test(auth.project) ||
      typeof auth.key !== 'string' ||
      !auth.key ||
      !/^\w+$/.test(String(args.table))
    )
      throw Error('Invalid project binding')
    origin = 'https://' + auth.project + '.supabase.co'
    headers.apikey = auth.key
    headers.Authorization = 'Bearer ' + auth.key
  }
  const url = new URL(path.startsWith('https://') ? path : origin + path)
  for (const k of a.query)
    if (args[k] !== undefined) {
      if (!['string', 'number', 'boolean'].includes(typeof args[k]))
        throw Error('Invalid query field')
      url.searchParams.set(
        operation === 'revolut.business.transactions.read_page' && k === 'account_id'
          ? 'account'
          : k,
        String(args[k]),
      )
    }
  if (operation === 'github.repos.search') {
    if (!url.searchParams.has('sort')) url.searchParams.set('sort', 'updated')
    if (!url.searchParams.has('order')) url.searchParams.set('order', 'desc')
  }
  if (operation === 'github.repos.search' || operation === 'github.releases.list') {
    for (const [key, value] of [
      ['page', '1'],
      ['per_page', '30'],
    ])
      if (!url.searchParams.has(key)) url.searchParams.set(key, value)
  }
  if (operation === 'reddit.subreddit.new') {
    url.searchParams.set('raw_json', '1')
    if (!url.searchParams.has('limit')) url.searchParams.set('limit', '25')
  }
  if (operation === 'kit.subscribers.read_page') {
    const n = args.per_page ?? 100
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 100)
      throw Error('Invalid page size')
    url.searchParams.set('per_page', String(n))
  }
  if (operation === 'revolut.business.transactions.read_page') {
    const count = args.count ?? 100
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 1000)
      throw Error('Invalid transaction count')
    url.searchParams.set('count', String(count))
  }
  if (
    operation === 'loops.newsletter.create_campaign' &&
    (typeof args.name !== 'string' ||
      !args.name.trim() ||
      args.name.length > 200 ||
      /[\r\n]/.test(args.name))
  )
    throw Error('Invalid campaign name')
  const data = Object.fromEntries(
    a.body.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]),
  )
  let body: string | undefined
  if (a.method !== 'GET') {
    const form = providerId === 'twilio'
    headers['Content-Type'] = form ? 'application/x-www-form-urlencoded' : 'application/json'
    body =
      providerId === 'supabase_data'
        ? JSON.stringify(data.row)
        : form
          ? new URLSearchParams(data as Record<string, string>).toString()
          : JSON.stringify(data)
  }
  return {
    url,
    init: {
      method: a.method,
      headers,
      body,
      redirect: 'error' as const,
      signal: AbortSignal.timeout(60000),
    },
  }
}

export { probeMedia, convertMedia, scriptToNotebook, notebookToScript } from './local.js'
export { verifyLoopsWebhook, verifyTwilioWebhook } from './webhooks.js'
