/** Hidden idempotency marker placed at the start of each Action-owned answer. */
const REPLY_MARKER_PREFIX = '<!-- gitnexus-finding-reply:v1:';
const REPLY_MARKER_AT_START_RE = /^<!-- gitnexus-finding-reply:v1:[1-9][0-9]* -->/;
const MAX_REPLY_CHARS = 8_001;
const ZWSP = '\u200B';

/** Build the marker used to deduplicate one human review-comment trigger. */
export function reviewReplyMarker(triggerCommentId: number): string {
  if (!Number.isSafeInteger(triggerCommentId) || triggerCommentId <= 0) {
    throw new Error('invalid trigger comment id');
  }
  return `${REPLY_MARKER_PREFIX}${triggerCommentId} -->`;
}

/** True only for an Action-rendered answer marker in its canonical lead position. */
export function startsWithReviewReplyMarker(body: string): boolean {
  return REPLY_MARKER_AT_START_RE.test(body);
}

/**
 * Render a Hub answer for a GitHub review thread. The Hub already sanitizes its
 * provider output; these transformations are an idempotent second boundary so
 * a malformed or older Hub cannot open HTML comments/fences or ping users.
 */
export function renderFindingReply(opts: {
  triggerCommentId: number;
  reply: string;
}): string {
  if (
    typeof opts.reply !== 'string' ||
    opts.reply.trim().length === 0 ||
    opts.reply.length > MAX_REPLY_CHARS
  ) {
    throw new Error('invalid finding reply');
  }
  return `${reviewReplyMarker(opts.triggerCommentId)}\n\n${neutralizeReply(opts.reply.trim())}`;
}

function neutralizeReply(text: string): string {
  return escapeAtMentions(escapeFenceLines(breakCommentDelimiters(text)));
}

function breakCommentDelimiters(text: string): string {
  return text.replace(/<!--/g, `<!-${ZWSP}-`).replace(/-->/g, `-${ZWSP}->`);
}

function escapeFenceLines(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      line.replace(
        /^((?:\s{0,3}(?:>\s?|[-*+]\s+|\d{1,9}[.)]\s+))*\s*)(`{3,}|~{3,})/,
        '$1\\$2',
      ),
    )
    .join('\n');
}

function escapeAtMentions(text: string): string {
  return text.replace(/(^|[^\w])@(?=[A-Za-z0-9])/g, `$1@${ZWSP}`);
}
