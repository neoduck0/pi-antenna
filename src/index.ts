/**
 * pi-antenna: gives the agent web access with `websearch` (Exa or Brave) and `webfetch` tools.
 * Modeled on OpenCode's websearch/webfetch tools.
 *
 * Configuration:
 *   EXA_API_KEY      optional; Exa's hosted MCP endpoint also works without a key (rate limited)
 *   BRAVE_API_KEY    required for Brave
 *   /websearch       pick the provider for this session: off, exa (default), or brave;
 *                    Ctrl+S in the picker saves it as the default (~/.pi/agent/pi-antenna.json)
 *   PI_ANTENNA_PROVIDER overrides the saved default (off|exa|brave)
 */

import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { StringEnum } from "@earendil-works/pi-ai"
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionAPI,
  type ExtensionContext,
  formatSize,
  getAgentDir,
  truncateHead,
} from "@earendil-works/pi-coding-agent"
import { Text } from "@earendil-works/pi-tui"
import { Type } from "typebox"
import { DEFAULT_TIMEOUT_SECONDS, type Format, MAX_TIMEOUT_SECONDS, webFetch } from "./fetch.ts"
import { type SelectorResult, WebSearchSelector } from "./selector.ts"
import { HttpError, type Provider, type ProviderID, providers, type SearchResult } from "./search.ts"

type Selection = ProviderID | "off"
const SELECTIONS: Selection[] = ["off", "exa", "brave"]
const DEFAULT_SELECTION: Selection = "exa"
const STATE_ENTRY = "pi-antenna-provider"
const CONFIG_PATH = join(getAgentDir(), "pi-antenna.json")
const NO_RESULTS = "No search results found. Please try a different query."
const DEFAULT_RESULTS = 8
const MAX_RESULTS = 20

// ---------------------------------------------------------------------------------------------------------------
// Config

async function loadSelection(): Promise<Selection> {
  const env = process.env.PI_ANTENNA_PROVIDER as Selection | undefined
  if (env && SELECTIONS.includes(env)) return env
  try {
    const value = JSON.parse(await readFile(CONFIG_PATH, "utf8"))?.provider
    if (SELECTIONS.includes(value)) return value
  } catch {}
  return DEFAULT_SELECTION
}

async function saveSelection(selection: Selection) {
  let config: Record<string, unknown> = {}
  try {
    config = JSON.parse(await readFile(CONFIG_PATH, "utf8"))
  } catch {}
  config.provider = selection
  await mkdir(dirname(CONFIG_PATH), { recursive: true })
  await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`)
}

function describeError(error: unknown) {
  if (error instanceof HttpError) {
    if (error.status === 429) return `${error.provider}: rate limited (HTTP 429)`
    if (error.status === 401 || error.status === 403 || error.status === 422)
      return `${error.provider}: authentication failed (HTTP ${error.status}); check ${providers[error.provider].env}`
    return error.message
  }
  if (error instanceof Error && error.name === "TimeoutError") return "timed out"
  return error instanceof Error ? error.message : String(error)
}

async function search(provider: Provider, query: string, count: number, signal: AbortSignal) {
  try {
    return await provider.search(query, count, AbortSignal.any([signal, AbortSignal.timeout(25_000)]))
  } catch (error) {
    if (signal.aborted) throw error
    throw new Error(`Unable to search the web for "${query}" via ${provider.name}: ${describeError(error)}`)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Output helpers

async function truncate(text: string, prefix: string) {
  const truncation = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES })
  if (!truncation.truncated) return { text, fullOutputPath: undefined }
  const dir = await mkdtemp(join(tmpdir(), `pi-${prefix}-`))
  const fullOutputPath = join(dir, "output.md")
  await writeFile(fullOutputPath, text, "utf8")
  const notice =
    `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines` +
    ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).` +
    ` Full output saved to: ${fullOutputPath}]`
  return { text: truncation.content + notice, fullOutputPath }
}

const formatResults = (results: SearchResult[]) =>
  results.length
    ? results
        .map((result) => {
          const title = result.title ?? result.url
          const published = result.published ? `\nPublished: ${new Date(result.published).toISOString()}` : ""
          return `## [${title}](${result.url})${published}${result.content ? `\n\n${result.content}` : ""}`
        })
        .join("\n\n")
    : NO_RESULTS

// ---------------------------------------------------------------------------------------------------------------
// Extension

interface SearchDetails {
  provider?: ProviderID
  results?: { url: string; title?: string }[]
  fullOutputPath?: string
}

interface FetchDetails {
  url?: string
  finalUrl?: string
  contentType?: string
  bytes?: number
  fullOutputPath?: string
}

export default function antenna(pi: ExtensionAPI) {
  let selection: Selection = DEFAULT_SELECTION
  let saved: Selection = DEFAULT_SELECTION

  const syncActive = () => {
    const active = new Set(pi.getActiveTools())
    if (selection === "off") active.delete("websearch")
    else active.add("websearch")
    pi.setActiveTools([...active])
  }

  // The current choice is session state (like /thinking); Ctrl+S in the picker saves the global default.
  const restore = async (ctx: ExtensionContext) => {
    saved = await loadSelection()
    selection = saved
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === STATE_ENTRY) {
        const value = (entry.data as { provider?: Selection } | undefined)?.provider
        if (value && SELECTIONS.includes(value)) selection = value
      }
    }
  }

  pi.on("session_tree", async (_event, ctx) => {
    await restore(ctx)
    syncActive()
  })

  pi.on("session_start", async (_event, ctx) => {
    await restore(ctx)
    // Hide websearch when disabled, as OpenCode does, so the model isn't offered a dead tool.
    if (selection === "off") syncActive()
  })

  pi.registerTool({
    name: "websearch",
    label: "Web Search",
    description: `Search the web using the user's selected search provider (Exa or Brave). Use this for current information beyond your knowledge cutoff, documentation lookups, or finding URLs to read with webfetch.

The current year is ${new Date().getFullYear()}. Use this year when searching for recent information or current events.`,
    promptSnippet: "Search the web for up-to-date information",
    promptGuidelines: [
      "Use websearch for current events, recent releases, or facts beyond your knowledge cutoff; follow up with webfetch to read promising results in full.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Websearch query" }),
      numResults: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_RESULTS,
          description: `Number of results to return (default ${DEFAULT_RESULTS}, max ${MAX_RESULTS})`,
        }),
      ),
    }),

    async execute(_id, params, signal, onUpdate) {
      const count = Math.min(Math.max(params.numResults ?? DEFAULT_RESULTS, 1), MAX_RESULTS)
      if (selection === "off") throw new Error("Web search is disabled. Run /websearch to choose a provider.")
      const provider = providers[selection]
      onUpdate?.({ content: [{ type: "text", text: `Searching via ${provider.name}…` }], details: { provider: provider.id } })
      const results = await search(provider, params.query, count, signal ?? new AbortController().signal)
      const { text, fullOutputPath } = await truncate(formatResults(results), "websearch")
      return {
        content: [{ type: "text", text }],
        details: {
          provider: provider.id,
          results: results.map(({ url, title }) => ({ url, title })),
          fullOutputPath,
        } as SearchDetails,
      }
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("websearch "))
      text += theme.fg("accent", `"${args.query ?? ""}"`)
      if (args.numResults) text += theme.fg("dim", ` (${args.numResults})`)
      return new Text(text, 0, 0)
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as SearchDetails | undefined
      if (isPartial) {
        const name = details?.provider ? providers[details.provider].name : "provider"
        return new Text(theme.fg("warning", `Searching via ${name}…`), 0, 0)
      }
      const items = details?.results ?? []
      if (!details?.provider) {
        const first = result.content[0]
        return new Text(theme.fg("error", first?.type === "text" ? first.text : "Search failed"), 0, 0)
      }
      let text = theme.fg("success", `${items.length} result${items.length === 1 ? "" : "s"}`)
      text += theme.fg("dim", ` via ${providers[details.provider].name}`)
      const shown = expanded ? items : items.slice(0, 3)
      for (const item of shown) text += `\n  ${theme.fg("muted", item.title ?? item.url)} ${theme.fg("dim", item.url)}`
      if (!expanded && items.length > shown.length) text += `\n  ${theme.fg("dim", `… ${items.length - shown.length} more`)}`
      return new Text(text, 0, 0)
    },
  })

  pi.registerTool({
    name: "webfetch",
    label: "Web Fetch",
    description: `Fetch content from an HTTP or HTTPS URL and return it as markdown (default), plain text, or raw HTML. Images (PNG, JPEG, GIF, WebP) are returned as image attachments.

This tool is read-only. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; if truncated, the full output is saved to a temp file you can read.`,
    promptSnippet: "Fetch a URL as markdown, text, or HTML",
    promptGuidelines: ["Use webfetch to read a specific web page or URL instead of curl/wget through bash."],
    parameters: Type.Object({
      url: Type.String({ description: "The HTTP or HTTPS URL to fetch content from" }),
      format: Type.Optional(
        StringEnum(["markdown", "text", "html"] as const, {
          description: "The format to return the content in. Defaults to markdown.",
        }),
      ),
      timeout: Type.Optional(
        Type.Number({
          exclusiveMinimum: 0,
          maximum: MAX_TIMEOUT_SECONDS,
          description: `Optional timeout in seconds (default ${DEFAULT_TIMEOUT_SECONDS}, maximum ${MAX_TIMEOUT_SECONDS})`,
        }),
      ),
    }),

    async execute(_id, params, signal) {
      let result
      try {
        result = await webFetch({ url: params.url, format: (params.format ?? "markdown") as Format, timeout: params.timeout }, signal)
      } catch (error) {
        throw new Error(`Unable to fetch ${params.url}: ${error instanceof Error ? error.message : String(error)}`)
      }
      const base = { url: result.url, finalUrl: result.finalUrl, contentType: result.contentType }
      if (result.kind === "image") {
        return {
          content: [
            { type: "text", text: `Fetched image ${result.finalUrl} (${result.contentType})` },
            { type: "image", data: result.data, mimeType: result.contentType },
          ],
          details: { ...base, bytes: Math.floor((result.data.length * 3) / 4) } as FetchDetails,
        }
      }
      const header = result.finalUrl !== result.url.split("#")[0] ? `Redirected to: ${result.finalUrl}\n\n` : ""
      const { text, fullOutputPath } = await truncate(header + result.output, "webfetch")
      return {
        content: [{ type: "text", text: text || "(empty response)" }],
        details: { ...base, bytes: Buffer.byteLength(result.output), fullOutputPath } as FetchDetails,
      }
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("webfetch "))
      text += theme.fg("accent", args.url ?? "")
      if (args.format && args.format !== "markdown") text += theme.fg("dim", ` (${args.format})`)
      return new Text(text, 0, 0)
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Fetching…"), 0, 0)
      const details = result.details as FetchDetails | undefined
      const first = result.content[0]
      if (!details?.contentType) return new Text(theme.fg("error", first?.type === "text" ? first.text : "Fetch failed"), 0, 0)
      let text = theme.fg("success", formatSize(details.bytes ?? 0))
      text += theme.fg("dim", ` ${details.contentType.split(";")[0]}`)
      if (details.finalUrl && details.finalUrl !== details.url) text += theme.fg("dim", ` → ${details.finalUrl}`)
      if (details.fullOutputPath) text += theme.fg("warning", " (truncated)")
      if (expanded && first?.type === "text") {
        const lines = first.text.split("\n")
        for (const line of lines.slice(0, 40)) text += `\n${theme.fg("dim", line)}`
        if (lines.length > 40) text += `\n${theme.fg("muted", `… ${lines.length - 40} more lines`)}`
      }
      return new Text(text, 0, 0)
    },
  })

  const apply = async (choice: Selection, persist: boolean, ctx: ExtensionContext) => {
    selection = choice
    if (persist) {
      await saveSelection(choice)
      saved = choice
    }
    pi.appendEntry(STATE_ENTRY, { provider: choice })
    syncActive()
    const provider = choice === "off" ? undefined : providers[choice]
    if (provider && !provider.available()) ctx.ui.notify(`Set ${provider.env} to use ${provider.name}.`, "warning")
    else ctx.ui.notify(persist ? `Default web search: ${choice}` : `Web search: ${choice}`, "info")
  }

  pi.registerCommand("websearch", {
    description: "Select web search provider (off, exa, brave)",
    getArgumentCompletions: (prefix) => {
      const items = SELECTIONS.filter((s) => s.startsWith(prefix.trim().toLowerCase())).map((s) => ({
        value: s,
        label: s,
      }))
      return items.length ? items : null
    },
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase()
      if (arg) {
        if (!SELECTIONS.includes(arg as Selection)) {
          ctx.ui.notify(`Unknown web search provider "${args.trim()}". Available: ${SELECTIONS.join(", ")}.`, "error")
          return
        }
        await apply(arg as Selection, false, ctx)
        return
      }
      if (!ctx.hasUI) {
        ctx.ui.notify(`Web search: ${selection} (default: ${saved})`, "info")
        return
      }
      const result = await ctx.ui.custom<SelectorResult>(
        (_tui, theme, keybindings, done) =>
          new WebSearchSelector(
            theme,
            keybindings,
            {
              current: selection,
              saved,
              items: SELECTIONS,
            },
            done,
          ),
      )
      if (result) await apply(result.value as Selection, result.persist, ctx)
    },
  })
}
