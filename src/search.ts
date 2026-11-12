// Web search providers. Exa follows OpenCode's implementation (hosted MCP endpoint, works without a key);
// Brave uses the Brave Search web API and requires BRAVE_API_KEY.

export type ProviderID = "exa" | "brave"

export interface SearchResult {
  url: string
  title?: string
  content?: string
  published?: number
}

export interface Provider {
  id: ProviderID
  name: string
  env: string
  /** Whether the provider can be used right now (credentials present, or none needed). */
  available: () => boolean
  search: (query: string, count: number, signal: AbortSignal) => Promise<SearchResult[]>
}

export class HttpError extends Error {
  readonly provider: ProviderID
  readonly status: number
  readonly retryAfter: string | null
  constructor(provider: ProviderID, status: number, retryAfter: string | null, body: string) {
    super(`${provider} search failed (HTTP ${status})${body ? `: ${body.slice(0, 300)}` : ""}`)
    this.provider = provider
    this.status = status
    this.retryAfter = retryAfter
  }
}

const MAX_RESPONSE_BYTES = 256 * 1024

async function readBounded(response: Response, maxBytes: number, signal?: AbortSignal) {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`Response too large (exceeds ${maxBytes} bytes)`)
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new Error("Aborted")
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) throw new Error(`Response too large (exceeds ${maxBytes} bytes)`)
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
    if (size > maxBytes || signal?.aborted) await response.body.cancel().catch(() => {})
  }
  const out = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}
export { readBounded }

// ---------------------------------------------------------------------------------------------------------------
// Exa

const EXA_ENDPOINT = "https://mcp.exa.ai/mcp"

/** MCP responses may be plain JSON or an SSE stream with `data:` lines. */
function parseMcpResult(body: string): any {
  const parse = (payload: string) => {
    const trimmed = payload.trim()
    if (!trimmed.startsWith("{")) return undefined
    const json = JSON.parse(trimmed)
    if (json.error) throw new Error(`Exa MCP error: ${json.error.message ?? JSON.stringify(json.error)}`)
    return json.result
  }
  const direct = parse(body)
  if (direct) return direct
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue
    const data = parse(line.slice(6))
    if (data) return data
  }
  return undefined
}

function parseExaResults(text: string): SearchResult[] {
  return text.split(/\n\n---\n\n/).flatMap((block) => {
    const url = block.match(/^URL:\s*(.+)$/m)?.[1]?.trim()
    if (!url) return []
    const title = block.match(/^Title:\s*(.+)$/m)?.[1]?.trim()
    const publishedText = block.match(/^Published:\s*(.+)$/m)?.[1]?.trim()
    const published = publishedText && publishedText !== "N/A" ? Date.parse(publishedText) : undefined
    const content = block.match(/^(?:Highlights|Text):\s*\n?([\s\S]*)$/m)?.[1]?.trim()
    return [
      {
        url,
        ...(title && title !== "N/A" ? { title } : {}),
        ...(content ? { content } : {}),
        ...(published !== undefined && Number.isFinite(published) ? { published } : {}),
      },
    ]
  })
}

export const exa: Provider = {
  id: "exa",
  name: "Exa",
  env: "EXA_API_KEY",
  available: () => true, // the hosted MCP endpoint has a free, keyless tier
  async search(query, count, signal) {
    const url = new URL(EXA_ENDPOINT)
    const key = process.env.EXA_API_KEY
    if (key) url.searchParams.set("exaApiKey", key)
    const response = await fetch(url, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "web_search_exa", arguments: { query, numResults: count } },
      }),
    })
    const body = new TextDecoder().decode(await readBounded(response, MAX_RESPONSE_BYTES, signal))
    if (!response.ok) throw new HttpError("exa", response.status, response.headers.get("retry-after"), body)
    const result = parseMcpResult(body)
    if (result?.isError) {
      const message = result.content?.find((item: any) => item?.text)?.text
      throw new Error(`Exa search failed${message ? `: ${message}` : ""}`)
    }
    const text = result?.content?.find((item: any) => item?.type === "text" && item.text)?.text
    return text ? parseExaResults(text).slice(0, count) : []
  },
}

// ---------------------------------------------------------------------------------------------------------------
// Brave

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search"

const decodeEntities = (value: string) =>
  value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")

/** Brave snippets contain light markup such as `<strong>`. */
const stripTags = (value: string | undefined) => (value ? decodeEntities(value.replace(/<[^>]*>/g, "")).trim() : "")

export const brave: Provider = {
  id: "brave",
  name: "Brave",
  env: "BRAVE_API_KEY",
  available: () => !!process.env.BRAVE_API_KEY,
  async search(query, count, signal) {
    const key = process.env.BRAVE_API_KEY
    if (!key) throw new Error("Brave search requires the BRAVE_API_KEY environment variable")
    const url = new URL(BRAVE_ENDPOINT)
    url.searchParams.set("q", query)
    url.searchParams.set("count", String(Math.min(count, 20)))
    url.searchParams.set("extra_snippets", "true")
    url.searchParams.set("text_decorations", "false")
    const response = await fetch(url, {
      signal,
      headers: { Accept: "application/json", "X-Subscription-Token": key },
    })
    const body = new TextDecoder().decode(await readBounded(response, MAX_RESPONSE_BYTES * 4, signal))
    if (!response.ok) throw new HttpError("brave", response.status, response.headers.get("retry-after"), body)
    const json = JSON.parse(body)
    const results: any[] = json?.web?.results ?? []
    return results.flatMap((item): SearchResult[] => {
      if (typeof item?.url !== "string") return []
      const snippets = [stripTags(item.description), ...(item.extra_snippets ?? []).map(stripTags)].filter(Boolean)
      const published = item.page_age ? Date.parse(item.page_age) : undefined
      return [
        {
          url: item.url,
          ...(item.title ? { title: stripTags(item.title) } : {}),
          ...(snippets.length ? { content: snippets.join("\n\n") } : {}),
          ...(published !== undefined && Number.isFinite(published) ? { published } : {}),
        },
      ]
    })
  },
}

export const providers: Record<ProviderID, Provider> = { exa, brave }
