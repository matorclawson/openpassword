import { z } from 'zod'
const fields = {
  size_bytes: z
    .number()
    .int()
    .positive()
    .max(256 * 1024 ** 3),
  content_sha256: z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/),
}
const media = z
  .object({
    ...fields,
    mime_type: z.enum(['video/mp4', 'video/quicktime', 'video/webm']),
    metadata: z
      .object({
        title: z.string().min(1).max(100),
        description: z.string().max(5000).default(''),
        tags: z.array(z.string()).default([]),
        category_id: z
          .string()
          .regex(/^\d{1,4}$/)
          .optional(),
        default_language: z.string().max(32).optional(),
      })
      .strict(),
    status: z
      .object({
        privacy: z.enum(['private', 'public', 'unlisted']),
        made_for_kids: z.boolean().default(false),
        publish_at: z.iso.datetime({ offset: true }).optional(),
      })
      .strict(),
    notify_subscribers: z.boolean().default(false),
  })
  .strict()
const thumb = z
  .object({
    ...fields,
    video_id: z.string().regex(/^[\w-]{11}$/),
    size_bytes: z.number().int().positive().max(2097152),
    mime_type: z.enum(['image/jpeg', 'image/png']),
  })
  .strict()
const caption = z
  .object({
    ...fields,
    video_id: z.string().regex(/^[\w-]{11}$/),
    size_bytes: z
      .number()
      .int()
      .positive()
      .max(100 * 1024 ** 2),
    mime_type: z.enum(['text/vtt', 'application/x-subrip']),
    name: z.string().max(150).default(''),
    language: z.string().regex(/^[a-zA-Z][\w-]{0,31}$/),
  })
  .strict()
export function uploadRequest(op: string, args: unknown) {
  const root = 'https://www.googleapis.com/upload/youtube/v3/'
  if (op === 'youtube.video.upload_session.create') {
    const b = media.parse(args),
      m = b.metadata,
      s = b.status
    if (s.publish_at && s.privacy !== 'private')
      throw Error('Scheduled videos require private visibility')
    return {
      url: new URL(
        root +
          'videos?part=snippet,status&uploadType=resumable&notifySubscribers=' +
          b.notify_subscribers,
      ),
      mime: b.mime_type,
      size: b.size_bytes,
      body: {
        snippet: {
          title: m.title,
          description: m.description,
          tags: m.tags,
          categoryId: m.category_id,
          defaultLanguage: m.default_language,
        },
        status: {
          privacyStatus: s.privacy,
          selfDeclaredMadeForKids: s.made_for_kids,
          publishAt: s.publish_at,
        },
      },
    }
  }
  if (op === 'youtube.thumbnail.upload_session.create') {
    const b = thumb.parse(args)
    return {
      url: new URL(root + 'thumbnails/set?uploadType=resumable&videoId=' + b.video_id),
      mime: b.mime_type,
      size: b.size_bytes,
      body: undefined,
    }
  }
  const b = caption.parse(args)
  return {
    url: new URL(root + 'captions?uploadType=resumable&part=snippet'),
    mime: b.mime_type,
    size: b.size_bytes,
    body: { snippet: { videoId: b.video_id, language: b.language, name: b.name } },
  }
}
