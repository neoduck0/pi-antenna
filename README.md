# pi-antenna

A Pi extension that gives the agent web access. Modeled on OpenCode's `websearch` / `webfetch` tools.

## Tools

- **`websearch`** `{ query, numResults? }`: searches with Exa or Brave and returns markdown results (title, URL, published date, snippets).
- **`webfetch`** `{ url, format?: "markdown" | "text" | "html", timeout? }`: fetches a URL and converts HTML to markdown (OpenCode's converter). PNG, JPEG, GIF and WebP images come back as image attachments. Redirects are followed manually, up to 10 hops. On a Cloudflare challenge it retries with a plain user agent. Output is limited to 50KB / 2000 lines, and the full text goes to a temp file.

## Providers

| Provider | Env | Notes |
|---|---|---|
| Exa | `EXA_API_KEY` (optional) | Hosted MCP endpoint `mcp.exa.ai`; works without a key (rate limited) |
| Brave | `BRAVE_API_KEY` (required) | Brave Search Web API with extra snippets |

`/websearch` opens a picker with three options: `off`, `exa` (default) and `brave`. Type to filter. **Enter** sets the provider for the current session; **Ctrl+S** saves it as the default in `~/.pi/agent/pi-antenna.json`. `/websearch <name>` switches directly, with tab completion. `PI_ANTENNA_PROVIDER` overrides the saved default. `off` removes `websearch` from the active tools.

## Install

```bash
pi install npm:pi-antenna
# or from git
pi install git:github.com/neoduck0/pi-antenna
# or try it once without installing
pi -e npm:pi-antenna
```

## Development

```bash
git clone https://github.com/neoduck0/pi-antenna && cd pi-antenna
npm install
npm run check          # type-check
pi -e .                # run Pi with the local copy
```

## License

MIT. `src/html-markdown.ts` is ported from OpenCode (MIT).
