/**
 * @brief: Error-classification module. Converts an unknown error (axios
 *         AxiosError, fetch Error, native Error, or arbitrary throw value)
 *         into a stable user-visible string suitable for `core.error` +
 *         `core.setFailed` in main.ts. Never inspects header values, never
 *         dumps response bodies wholesale, and never returns the
 *         GNX_TOKEN — GitHub's secret masker is a fallback, not a primary
 *         defense.
 */

/** Context of the call that failed. Controls the wording on certain codes. */
export type ErrorContext = 'hub' | 'github' | 'config';

/**
 * @brief: Minimal axios-error shape we recognise without importing axios.
 *         Keeping this local avoids a hard dependency on axios's runtime
 *         types from a pure module.
 */
interface AxiosLikeError {
  isAxiosError?: boolean;
  message?: string;
  code?: string;
  response?: {
    status?: number;
    statusText?: string;
    headers?: Record<string, string | string[] | undefined>;
    data?: unknown;
  };
  config?: { url?: string };
}

/**
 * @brief: Classify any thrown value into a single-line user-visible
 *         message. The message is safe to log and safe to include in a
 *         workflow summary — it never contains tokens, full URLs with
 *         secrets, or unmodified response bodies.
 *
 * @params: (err: unknown)      -> Whatever was caught in main.ts.
 * @params: (context: ErrorContext) -> 'hub' for GNX Hub calls, 'github' for Octokit calls.
 *
 * @returns: string — the user-visible failure reason.
 */
export function classifyError(err: unknown, context: ErrorContext): string {
  // Config errors are local input-validation throws (e.g. a bad
  // `fail-on-blast-level` value) carrying an intentional, stable message.
  // Pass that message through unchanged — only token-scrubbed — rather than
  // run it through HTTP-status classification that never applies here.
  if (context === 'config') {
    if (err instanceof Error) return scrubMessage(err.message || 'invalid configuration');
    return 'invalid configuration';
  }

  const axiosLike = asAxiosLike(err);
  if (axiosLike) {
    const status = axiosLike.response?.status;
    const code = axiosLike.code;

    if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
      return context === 'hub'
        ? 'Hub request timed out. Check Hub availability.'
        : 'GitHub request timed out. Try re-running the workflow.';
    }
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      return context === 'hub'
        ? 'Hub URL could not be resolved — check the `hub-url` input.'
        : 'GitHub API host could not be resolved.';
    }

    if (status !== undefined) {
      const fromStatus = classifyStatus(status, context, axiosLike);
      if (fromStatus !== null) return fromStatus;
    }

    if (isHtmlBody(axiosLike.response?.data)) {
      return 'Hub returned HTML instead of JSON — hub-url may be wrong.';
    }
  }

  if (err instanceof SchemaMismatchError) {
    return 'Hub returned unexpected response shape. Action and Hub may be on incompatible versions.';
  }

  if (err instanceof Error) {
    // Strip anything that looks like a token before returning.
    return scrubMessage(err.message || 'unknown error');
  }
  return 'unknown error';
}

/**
 * @brief: Distinct error type for shape-mismatches so main.ts can surface
 *         the schema message uniformly. Thrown by hub-client when
 *         isBlastResult / list-of-repos validation fails.
 *
 * @params: (message: string) -> Human-readable explanation for the throw site.
 */
export class SchemaMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaMismatchError';
  }
}

function classifyStatus(
  status: number,
  context: ErrorContext,
  err: AxiosLikeError,
): string | null {
  // Hub-side classifications
  if (context === 'hub') {
    if (status === 401) {
      return 'GNX_TOKEN is invalid or revoked. Regenerate at <hub>/profile.';
    }
    if (status === 402) {
      return 'Plan limit exceeded — upgrade at <hub>/billing.';
    }
    if (status === 403) {
      // Distinguish device-token fingerprint missing from generic forbidden
      // by inspecting the (already-known-safe) response body shape.
      const reason = readErrorReason(err.response?.data);
      if (reason && reason.toLowerCase().includes('device-fingerprint')) {
        return 'Hub requires X-Device-Fingerprint header for this token — Action build is incomplete.';
      }
      return 'GNX_TOKEN does not have access to the requested repo on the Hub.';
    }
    if (status === 404) {
      const url = err.config?.url ?? '';
      if (url.endsWith('/api/repos') || url.includes('/api/repos?')) {
        return 'Hub /api/repos endpoint not found — hub-url may be wrong.';
      }
      // Discriminate: repo-not-registered (resolveRepoId path) vs blast endpoint absent
      if (/\/prs\//.test(url)) {
        return 'Hub blast endpoint not found — Action version may be incompatible with Hub.';
      }
      return 'Repo is not registered on the Hub. Link it at <hub>/repos.';
    }
    if (status === 429) {
      const retryAfter = readRetryAfter(err.response?.headers);
      return retryAfter
        ? `Hub rate limit hit — retry after ${retryAfter} seconds.`
        : 'Hub rate limit hit — retry shortly.';
    }
    if (status >= 500) {
      return `Hub returned ${status}. Check Hub status.`;
    }
  }

  // GitHub-side classifications
  if (context === 'github') {
    if (status === 401) {
      return 'GITHUB_TOKEN is invalid — re-check the `github-token` input.';
    }
    if (status === 403) {
      return 'Cannot post PR comment: missing pull-requests:write permission.';
    }
    if (status === 404) {
      return 'GitHub returned 404 — PR or issue may not exist.';
    }
    if (status === 422) {
      return 'Comment body rejected by GitHub (likely too large). Truncation failed — file an issue.';
    }
    if (status === 429) {
      return 'GitHub API rate limit hit — retry after a few minutes.';
    }
    if (status >= 500) {
      return `GitHub returned ${status}. Try re-running the workflow.`;
    }
  }

  return null;
}

function asAxiosLike(err: unknown): AxiosLikeError | null {
  if (!isObject(err)) return null;
  const candidate: AxiosLikeError = err;
  // We treat anything carrying a `response` with numeric status as
  // axios-shaped — fetch errors won't have it, and that's fine.
  if (candidate.isAxiosError === true) return candidate;
  if (candidate.response && typeof candidate.response.status === 'number') return candidate;
  if (typeof candidate.code === 'string' && /^(ECONN|ETIM|EAI_|ENOT|EHOST)/.test(candidate.code)) {
    return candidate;
  }
  return null;
}

function readErrorReason(data: unknown): string | null {
  if (!isObject(data)) return null;
  const v = data.error;
  return typeof v === 'string' ? v : null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function readRetryAfter(
  headers: Record<string, string | string[] | undefined> | undefined,
): number | null {
  if (!headers) return null;
  // axios lowercases response header keys; tolerate both shapes.
  const raw = headers['retry-after'] ?? headers['Retry-After'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isHtmlBody(data: unknown): boolean {
  if (typeof data !== 'string') return false;
  const trimmed = data.trim().slice(0, 40).toLowerCase();
  return trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html');
}

/**
 * @brief: Strip anything that looks like a `gnx_` token from a message
 *         before returning it. This is a fallback — call sites should
 *         never produce token-containing messages — but it's cheap and
 *         protects against future bugs.
 *
 * @params: (msg: string) -> Raw error message text.
 *
 * @returns: string — same message with any gnx_-prefixed substrings redacted.
 */
function scrubMessage(msg: string): string {
  return msg.replace(/gnx_[A-Za-z0-9_-]+/g, 'gnx_[redacted]');
}
