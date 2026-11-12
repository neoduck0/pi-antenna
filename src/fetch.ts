// Port of OpenCode's webfetch tool to plain fetch().

import { convertHTMLToMarkdown, extractTextFromHTML, MAX_MARKDOWN_BYTES } from "./html-markdown.ts"
import { readBounded } from "./search.ts"

export type Format = "markdown" | "text" | "html"

export const MAX_RESPONSE_BYTES = MAX_MARKDOWN_BYTES
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const DEFAULT_TIMEOUT_SECONDS = 30
export const MAX_TIMEOUT_SECONDS = 120
export const MAX_REDIRECTS = 10

const USER_AGENT =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; pi-antenna; +https://github.com/neoduck0/pi-antenna"
const FALLBACK_USER_AGENT = "pi-antenna"
const redirectStatuses = new Set([301, 302, 303, 307, 308])
const inlineImageTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

const acceptHeader = (format: Format) => {
  switch (format) {
    case "markdown":
      return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
    case "text":
      return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
    case "html":
      return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1"
  }
}

export function assertHttpUrl(url: URL) {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("URL must use http:// or https://")
  if (url.username || url.password) throw new Error("URL must not include credentials")
}

export const isTextual = (mime: string) =>
  !mime ||
  mime.startsWith("text/") ||
  mime === "application/json" ||
  mime.endsWith("+json") ||
  mime === "application/xml" ||
  mime.endsWith("+xml") ||
  mime === "application/javascript" ||
  mime === "application/x-javascript"

const mimeFrom = (contentType: string) => contentType.split(";", 1)[0]?.trim().toLowerCase() ?? ""

const charsetPattern = /charset\s*=\s*["']?([\w.:-]+)/i

/** Decodes using the header charset, then an HTML `<meta charset>` near the top, then UTF-8. */
function decode(bytes: Uint8Array, contentType: string, isHtml: boolean) {
  let charset = charsetPattern.exec(contentType)?.[1]
  if (!charset && isHtml) {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048))
    charset = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1]
  }
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes)
  } catch {
    return new TextDecoder().decode(bytes) // unknown label
  }
}

/** Follows redirects manually so each hop is validated and counted. */
async function request(url: string, format: Format, userAgent: string, signal: AbortSignal) {
  let current = url
  for (let redirects = 0; ; redirects++) {
    const response = await fetch(current, {
      redirect: "manual",
      signal,
      headers: { "User-Agent": userAgent, Accept: acceptHeader(format), "Accept-Language": "en-US,en;q=0.9" },
    })
    const location = response.headers.get("location")
    if (!redirectStatuses.has(response.status) || !location) return { response, url: current }
    await response.body?.cancel().catch(() => {})
    if (redirects >= MAX_REDIRECTS) throw new Error(`Too many redirects (more than ${MAX_REDIRECTS})`)
    const target = new URL(location, current)
    assertHttpUrl(target)
    target.hash = ""
    current = target.href
  }
}

export type FetchResult =
  | { kind: "text"; url: string; finalUrl: string; status: number; contentType: string; format: Format; output: string }
  | { kind: "image"; url: string; finalUrl: string; status: number; contentType: string; data: string }

export async function webFetch(
  input: { url: string; format: Format; timeout?: number },
  parentSignal: AbortSignal | undefined,
): Promise<FetchResult> {
  const url = input.url.split("#")[0]!
  assertHttpUrl(new URL(url))

  const timeout = Math.min(Math.max(input.timeout ?? DEFAULT_TIMEOUT_SECONDS, 1), MAX_TIMEOUT_SECONDS)
  const timeoutSignal = AbortSignal.timeout(timeout * 1000)
  const signal = parentSignal ? AbortSignal.any([parentSignal, timeoutSignal]) : timeoutSignal

  try {
    let { response, url: finalUrl } = await request(url, input.format, USER_AGENT, signal)
    // Cloudflare's bot challenge often lets a plain, honest UA through.
    if (response.status === 403 && response.headers.get("cf-mitigated") === "challenge") {
      await response.body?.cancel().catch(() => {})
      ;({ response, url: finalUrl } = await request(url, input.format, FALLBACK_USER_AGENT, signal))
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`)
    }

    const contentType = response.headers.get("content-type") ?? ""
    const mime = mimeFrom(contentType)
    if (inlineImageTypes.has(mime)) {
      const body = await readBounded(response, MAX_IMAGE_BYTES, signal)
      return {
        kind: "image",
        url: input.url,
        finalUrl,
        status: response.status,
        contentType: mime,
        data: Buffer.from(body).toString("base64"),
      }
    }
    if (!isTextual(mime)) {
      await response.body?.cancel().catch(() => {})
      throw new Error(`Unsupported content type: ${mime}`)
    }

    const isHtml = mime === "text/html" || mime === "application/xhtml+xml"
    const content = decode(await readBounded(response, MAX_RESPONSE_BYTES, signal), contentType, isHtml)
    const output = !isHtml
      ? content
      : input.format === "markdown"
        ? convertHTMLToMarkdown(content)
        : input.format === "text"
          ? extractTextFromHTML(content)
          : content
    return { kind: "text", url: input.url, finalUrl, status: response.status, contentType, format: input.format, output }
  } catch (error) {
    if (timeoutSignal.aborted && !parentSignal?.aborted) throw new Error(`Request timed out after ${timeout}s`)
    throw error
  }
}
