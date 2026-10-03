// Secret redaction for every log, error and halt string (SEC-OPS-03; RPC URLs embed API keys, pg errors can echo
// connection strings). A copy of the frozen API redactor (packages/api/src/contracts/redact.ts), because this package
// must never import @pine/api; keep the two in sync.
export type Redactor = (input: string) => string;

const REDACTED = "[REDACTED]";
const MAX_INPUT = 64 * 1024;
const MAX_OUTPUT = 2_000;

/** Hosts whose URL paths are public and safe to keep when there is no userinfo and no query. */
const PUBLIC_URL_HOSTS = new Set(["github.com", "api.github.com", "gnosisscan.io", "gnosis.blockscout.com", "etherscan.io", "ipfs.io", "seer.pm", "app.seer.pm"]);

// Any scheme://... URL (http, https, ws, wss, postgres, postgresql, mysql, redis, rediss, amqp, mongodb, ...).
const URL_PATTERN = /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s"'<>`]+/gi;
// Scheme-less credentials "user:password@host".
const USERINFO_PATTERN = /\b[^\s:@/"'<>]{1,64}:[^\s:@/"'<>]{1,256}@[a-z0-9.-]+\.[a-z]{2,}\b/gi;
const PEM_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
const TOKEN_PATTERNS: RegExp[] = [
  // GitHub tokens (classic, OAuth, user-to-server, server-to-server, refresh, fine-grained).
  /(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  // Pine-issued opaque tokens.
  /(?<![A-Za-z0-9])pine_[a-z0-9]{1,8}_[A-Za-z0-9_-]{16,}/g,
  // Authorization header values.
  /\b(?:Authorization|Proxy-Authorization)\s*[:=]\s*(?:Bearer|Basic|Token|token)?\s*[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
  // JWT-shaped strings.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // Un-prefixed 32-byte hex (raw private keys, raw tokens). 0x-prefixed hashes/addresses are public chain data.
  /(?<![0-9a-fA-Fx])[a-fA-F0-9]{64}(?![0-9a-fA-F])/g,
];
// key=value / "key": "value" pairs whose key names a secret. Quoted values are consumed up to the closing quote.
const LABEL_PATTERN =
  /((?:private[_-]?key|secret|client[_-]?secret|password|passphrase|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|token|auth|authorization|credential|cookie|set-cookie|session|code|state|dkey|mnemonic|seed)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s"',;&}]+)/gi;

function scrubUrl(match: string): string {
  // Trailing punctuation is usually prose, not part of the URL.
  const trailing = /[).,;\]]+$/.exec(match)?.[0] ?? "";
  const body = trailing ? match.slice(0, -trailing.length) : match;
  try {
    const url = new URL(body);
    const hasCredentials = url.username !== "" || url.password !== "";
    const hasQuery = url.search !== "" || url.hash !== "";
    const isWeb = url.protocol === "http:" || url.protocol === "https:";
    if (isWeb && !hasCredentials && !hasQuery && PUBLIC_URL_HOSTS.has(url.hostname.toLowerCase())) {
      return `${url.protocol}//${url.host}${url.pathname}${trailing}`;
    }
    const keepsNothing = url.pathname.length <= 1 && !hasCredentials && !hasQuery;
    return `${url.protocol}//${url.host}${keepsNothing ? "" : `/${REDACTED}`}${trailing}`;
  } catch {
    return `${REDACTED}${trailing}`;
  }
}

/**
 * Builds a redactor that removes every known secret value (exact match, including URL-encoded forms) and every
 * pattern above. Known secrets shorter than 8 characters are ignored (they would destroy ordinary text). Input is
 * truncated to 64 KiB before matching and output to 2,000 characters.
 */
export function createRedactor(knownSecrets: readonly string[] = []): Redactor {
  const exact = Array.from(
    new Set(
      knownSecrets
        .filter((secret) => typeof secret === "string" && secret.length >= 8)
        .flatMap((secret) => [secret, encodeURIComponent(secret)]),
    ),
  ).sort((a, b) => b.length - a.length);

  return (input: string): string => {
    let output = String(input).slice(0, MAX_INPUT);
    for (const secret of exact) output = output.split(secret).join(REDACTED);
    output = output.replace(PEM_PATTERN, REDACTED);
    output = output.replace(URL_PATTERN, scrubUrl);
    output = output.replace(USERINFO_PATTERN, REDACTED);
    for (const pattern of TOKEN_PATTERNS) output = output.replace(pattern, REDACTED);
    output = output.replace(LABEL_PATTERN, (_match: string, label: string) => `${label}${REDACTED}`);
    return output.length > MAX_OUTPUT ? `${output.slice(0, MAX_OUTPUT)}...` : output;
  };
}

/** A safe, redacted, bounded message for an unknown thrown value. Never includes stacks, causes or response bodies. */
export function safeErrorMessage(error: unknown, redact: Redactor): string {
  if (error instanceof Error) {
    const short = (error as { shortMessage?: unknown }).shortMessage;
    const base = typeof short === "string" && short.length > 0 ? short : error.message;
    return redact(`${error.name}: ${base}`);
  }
  return redact(typeof error === "string" ? error : "Unknown error");
}

