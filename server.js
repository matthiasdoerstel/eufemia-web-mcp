import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import express from 'express'
import cors from 'cors'
import { readFileSync, readdirSync, existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { z } from 'zod'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ─── Load versioned data ──────────────────────────────────────────────────────

function loadLatestData() {
  const dataDir = path.join(__dirname, 'data')

  if (!existsSync(dataDir)) {
    throw new Error('No data/ directory found. Run: node scripts/extract.mjs --version <x.y.z>')
  }

  // Find highest vX directory
  const versions = readdirSync(dataDir)
    .filter(d => /^v\d+$/.test(d))
    .sort((a, b) => parseInt(b.slice(1)) - parseInt(a.slice(1)))

  if (versions.length === 0) {
    throw new Error('No versioned data found in data/. Run: node scripts/extract.mjs --version <x.y.z>')
  }

  const latest = versions[0]
  const dir = path.join(dataDir, latest)

  const meta = JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf-8'))
  const primitiveTokens = JSON.parse(readFileSync(path.join(dir, 'tokens-primitive.json'), 'utf-8'))
  const icons = JSON.parse(readFileSync(path.join(dir, 'icons.json'), 'utf-8'))
  const components = JSON.parse(readFileSync(path.join(dir, 'components.json'), 'utf-8'))

  // Load per-theme token files
  const availableThemes = meta.themes ?? ['ui']
  const themeTokens = {}
  for (const theme of availableThemes) {
    themeTokens[theme] = {
      scale: existsSync(path.join(dir, `tokens-scale-${theme}.json`))
        ? JSON.parse(readFileSync(path.join(dir, `tokens-scale-${theme}.json`), 'utf-8'))
        : JSON.parse(readFileSync(path.join(dir, 'tokens-scale.json'), 'utf-8')),
      semantic: existsSync(path.join(dir, `tokens-semantic-${theme}.json`))
        ? JSON.parse(readFileSync(path.join(dir, `tokens-semantic-${theme}.json`), 'utf-8'))
        : JSON.parse(readFileSync(path.join(dir, 'tokens-semantic.json'), 'utf-8')),
      semanticDark: existsSync(path.join(dir, `tokens-semantic-dark-${theme}.json`))
        ? JSON.parse(readFileSync(path.join(dir, `tokens-semantic-dark-${theme}.json`), 'utf-8'))
        : (existsSync(path.join(dir, 'tokens-semantic-dark.json'))
            ? JSON.parse(readFileSync(path.join(dir, 'tokens-semantic-dark.json'), 'utf-8'))
            : [])
    }
  }

  console.log(`✓ Loaded Eufemia ${meta.eufemiaVersion} (extracted ${meta.extractedAt.slice(0, 10)})`)
  console.log(`  ${primitiveTokens.length} primitive tokens · ${icons.length} icons · ${Object.keys(components).length} components`)
  for (const theme of availableThemes) {
    const t = themeTokens[theme]
    console.log(`  [${theme}] ${t.scale.length} scale · ${t.semantic.length} semantic · ${t.semanticDark.length} dark`)
  }

  return { meta, primitiveTokens, themeTokens, availableThemes, icons, components, versions }
}

const { meta, primitiveTokens, themeTokens, availableThemes, icons, components, versions } = loadLatestData()

const baseIcons = icons
const iconSet = new Set(icons.map(i => i.name).concat(icons.filter(i => i.hasMedium).map(i => `${i.name}_medium`)))
const componentList = Object.keys(components)

// Resolve component by name, handling dot notation (Field.String → forms/field/string)
// and partial path suffix matching (field/string → forms/field/string)
function resolveComponent(input) {
  const normalised = input.toLowerCase().replace(/\s+/g, '-').replace(/\./g, '/')
  if (components[normalised]) return { key: normalised, data: components[normalised] }
  const match = componentList.find(k => k === normalised || k.endsWith('/' + normalised))
  return match ? { key: match, data: components[match] } : null
}

// Build the import statement for a component entry
function importStatement(data) {
  const importBase = data.importBase ?? '@dnb/eufemia'
  if (data.namespace) {
    // e.g. Field.String → import { Field } from '@dnb/eufemia/extensions/forms'
    return `import { ${data.namespace} } from '${importBase}'\n// Usage: <${data.namespace}.${data.subName} .../>`
  }
  return `import { ${toPascalCase(data.name)} } from '${importBase}'`
}

// ─── MCP Server factory ───────────────────────────────────────────────────────

function createMcpServer() {
  const server = new McpServer(
    { name: 'eufemia-mcp', version: meta.eufemiaVersion },
    { capabilities: { tools: {} } }
  )

  // Tool: get_design_tokens
  server.tool(
    'get_design_tokens',
    'Get DNB Eufemia design tokens. Use layer="semantic" (default) for contextual tokens (--token-color-background-*, etc.), layer="scale" for the raw color scale (--dnb-coldgreen-*, --dnb-greyscale-*, etc.), layer="primitive" for the legacy color palette (--color-sea-green, etc.), or layer="dark" for semantic dark mode values. Use theme to select a brand theme (default: "ui" = DNB).',
    {
      layer: z.enum(['semantic', 'scale', 'primitive', 'dark']).optional().describe('Token layer: "semantic" (default) — contextual tokens for building UI; "scale" — raw color scale values; "primitive" — legacy color palette (ui only); "dark" — semantic dark mode overrides'),
      theme: z.enum(['ui', 'sbanken', 'eiendom', 'carnegie']).optional().describe('Brand theme (default: "ui" = DNB). Other themes: "sbanken", "eiendom", "carnegie"'),
      category: z.string().optional().describe('Filter by name fragment (e.g. "background", "action", "text", "color", "spacing")'),
      search: z.string().optional().describe('Search by token name or value (e.g. "action", "#007272", "0.25rem")')
    },
    async ({ layer = 'semantic', theme = 'ui', category, search }) => {
      const tokens = themeTokens[theme] ?? themeTokens.ui
      const tokenMap = {
        semantic: tokens.semantic,
        scale: tokens.scale,
        primitive: primitiveTokens,
        dark: tokens.semanticDark
      }
      let filtered = tokenMap[layer] ?? tokens.semantic

      if (category) {
        const cat = category.toLowerCase()
        filtered = filtered.filter(t => t.name.toLowerCase().includes(cat))
      }

      if (search) {
        const q = search.toLowerCase()
        filtered = filtered.filter(t =>
          t.name.toLowerCase().includes(q) || String(t.value).toLowerCase().includes(q)
        )
      }

      const result = {
        layer,
        theme,
        total: filtered.length,
        note: filtered.length > 200 ? 'Results truncated to 200 — use category/search to narrow down' : undefined,
        tokens: filtered.slice(0, 200)
      }

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  // Tool: get_component_guidelines
  server.tool(
    'get_component_guidelines',
    "Get design guidelines for an Eufemia component: description, when to use it, variant recommendations, sizes, do's and don'ts, and Figma file link.",
    {
      component: z.string().describe('Component name in kebab-case (e.g. "button", "input", "modal", "breadcrumb", "date-picker")')
    },
    async ({ component }) => {
      const resolved = resolveComponent(component)

      if (!resolved) {
        const q = component.toLowerCase().replace(/\s+/g, '-').replace(/\./g, '/')
        const close = componentList.filter(c => c.includes(q) || q.includes(c.split('/').pop()))
        const suggestion = close.length > 0
          ? ` Did you mean: ${close.slice(0, 5).join(', ')}?`
          : ' Use search_components to find available components.'
        return {
          content: [{ type: 'text', text: `Component "${component}" not found.${suggestion}` }],
          isError: true
        }
      }

      const { key, data } = resolved
      const docsSlug = data.namespace
        ? `extensions/forms/${data.namespace}/${data.subName}`
        : key

      const text = [
        `## Import\n\n\`\`\`tsx\n${importStatement(data)}\n\`\`\``,
        data.guidelines || '_No guidelines available._',
        data.guidelines ? `\n## Relevant links\n\n- [Figma](https://www.figma.com/design/cdtwQD8IJ7pTeE45U148r1/%F0%9F%92%BB-Eufemia---Web)\n- [Docs](https://eufemia.dnb.no/uilib/${docsSlug}/)` : ''
      ].join('\n\n')

      return { content: [{ type: 'text', text }] }
    }
  )

  // Tool: get_component_code
  server.tool(
    'get_component_code',
    'Get the real React implementation for an Eufemia component. IMPORTANT: You MUST import and use the component directly from @dnb/eufemia — do NOT recreate, reimplement, or restyle it with custom CSS. The component is already fully styled. Just use the import and JSX examples exactly as shown. Do not wrap it in a custom component.',
    {
      component: z.string().describe('Component name in kebab-case (e.g. "button", "input", "modal", "date-picker") or dot notation for forms sub-components (e.g. "Field.String", "Form.Handler")')
    },
    async ({ component }) => {
      const resolved = resolveComponent(component)

      if (!resolved) {
        const q = component.toLowerCase().replace(/\s+/g, '-').replace(/\./g, '/')
        const close = componentList.filter(c => c.includes(q) || q.includes(c.split('/').pop()))
        const suggestion = close.length > 0
          ? ` Did you mean: ${close.slice(0, 5).join(', ')}?`
          : ' Use search_components to find available components.'
        return {
          content: [{ type: 'text', text: `Component "${component}" not found.${suggestion}` }],
          isError: true
        }
      }

      const { key, data } = resolved
      const sections = [
        `## Import\n\`\`\`tsx\n${importStatement(data)}\n\`\`\`\n\n> **IMPORTANT:** Use this import directly. Do NOT recreate or reimplement this component with custom CSS or wrappers. It is already fully styled by Eufemia.`
      ]

      if (data.code) {
        sections.push(`## Code Examples\n\`\`\`tsx\n${data.code}\n\`\`\``)
      } else {
        sections.push(`## Code Examples\nNot available for "${data.name}".`)
      }

      if (data.props?.length > 0) {
        const rows = data.props.map(p =>
          `| \`${p.name}\` | ${p.status} | ${String(p.type).replace(/\n/g, ' ')} | ${String(p.description).replace(/\n/g, ' ')} |`
        )
        sections.push(`## Props\n| Prop | Status | Type | Description |\n|------|--------|------|-------------|\n${rows.join('\n')}`)
      } else {
        const docsSlug = data.namespace
          ? `extensions/forms/${data.namespace}/${data.subName}`
          : key
        sections.push(`## Props\nCheck https://eufemia.dnb.no/uilib/${docsSlug}/properties/`)
      }

      return { content: [{ type: 'text', text: sections.join('\n\n') }] }
    }
  )

  // Tool: search_components
  server.tool(
    'search_components',
    'Search available Eufemia components by name or keyword. Returns component names with links to guidelines and documentation.',
    {
      query: z.string().describe('Search query (e.g. "button", "form", "Field", "Field.String", "Form.Handler", "input", "paragraph")')
    },
    async ({ query }) => {
      const q = query.toLowerCase().replace(/\./g, '/')
      const matches = componentList
        .filter(key => key.includes(q) || components[key].name?.toLowerCase().includes(q))
        .map(key => {
          const data = components[key]
          return {
            key,
            name: data.name,
            section: data.section,
            docs: `https://eufemia.dnb.no/uilib/${data.namespace ? `extensions/forms/${data.namespace}/${data.subName}` : key}/`,
          }
        })

      return { content: [{ type: 'text', text: JSON.stringify({ query, count: matches.length, results: matches }, null, 2) }] }
    }
  )

  // Tool: search_icons
  server.tool(
    'search_icons',
    'Search the Eufemia DNB icon library by name or keyword. Returns matching icons with size variants (default 16px / medium 24px).',
    {
      query: z.string().describe('Icon name or keyword (e.g. "arrow", "calendar", "user", "check", "home", "close")')
    },
    async ({ query }) => {
      const q = query.toLowerCase()
      const allMatches = baseIcons.filter(i => i.name.includes(q))
      const matches = allMatches
        .slice(0, 60)
        .map(i => ({
          name: i.name,
          sizes: i.hasMedium ? ['default (16px)', 'medium (24px)'] : ['default (16px)'],
          importDefault: `import ${toCamelCase(i.name)} from '@dnb/eufemia/icons/dnb/${i.name}'`,
          importMedium: i.hasMedium
            ? `import ${toCamelCase(i.name + '_medium')} from '@dnb/eufemia/icons/dnb/${i.name}_medium'`
            : null
        }))

      const result = {
        query,
        count: matches.length,
        truncated: allMatches.length > 60 ? `Showing 60 of ${allMatches.length} results — use a more specific query` : undefined,
        note: matches.length === 0 ? 'No icons found. Try a shorter or different keyword.' : undefined,
        results: matches
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  return server
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toPascalCase(str) {
  return str.split('-').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('')
}

function toCamelCase(str) {
  return str.replace(/(^[a-z])|[-_]([a-z])/g, (_, a, b) => (a || b).toUpperCase())
}

// ─── HTTP + SSE Express App ───────────────────────────────────────────────────

const app = express()
app.use(cors())
app.use(express.json())

const sessions = {}

app.get('/', (req, res) => res.redirect('/sse'))

app.get('/sse', async (req, res) => {
  res.setHeader('X-Accel-Buffering', 'no')
  req.socket.setNoDelay(true)

  const originalWrite = res.write.bind(res)
  res.write = (chunk, ...args) => {
    const str = chunk?.toString() || ''
    console.log(`← SSE write ${str.length} bytes: ${str.slice(0, 80).replace(/\n/g, '\\n')}`)
    return originalWrite(chunk, ...args)
  }

  const keepalive = setInterval(() => originalWrite(': keepalive\n\n'), 15000)
  res.on('close', () => clearInterval(keepalive))

  const transport = new SSEServerTransport('/message', res)
  if (transport.sessionId) {
    sessions[transport.sessionId] = transport
  }
  res.on('close', () => {
    if (transport.sessionId) {
      delete sessions[transport.sessionId]
    }
    console.log(`↙ Session disconnected: ${transport.sessionId}`)
  })

  console.log(`↗ New session: ${transport.sessionId}`)
  const mcpServer = createMcpServer()
  try {
    await mcpServer.connect(transport)
  } catch (err) {
    console.error(`Failed to connect MCP server for session ${transport.sessionId}:`, err)
    if (transport.sessionId) delete sessions[transport.sessionId]
    if (!res.headersSent) res.status(500).end()
  }
})

app.post('/message', async (req, res) => {
  const sessionId = req.query.sessionId
  const transport = sessions[sessionId]
  console.log(`→ POST /message session=${sessionId} method=${req.body?.method}`)
  if (!transport) return res.status(404).json({ error: `Session not found: ${sessionId}` })
  try {
    await transport.handlePostMessage(req, res, req.body)
  } catch (err) {
    console.error(`Error handling message for session ${sessionId}:`, err)
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' })
  }
})

app.get('/health', (_, res) => {
  res.json({
    status: 'ok',
    eufemiaVersion: meta.eufemiaVersion,
    extractedAt: meta.extractedAt,
    availableVersions: versions,
    themes: availableThemes,
    counts: meta.counts
  })
})
// ─── Start ────────────────────────────────────────────────────────────────────

process.on('uncaughtException', err => console.error('Uncaught exception:', err))
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err))

const PORT = process.env.PORT || 3456
app.listen(PORT, () => {
  console.log(`\nEufemia MCP Server  http://localhost:${PORT}`)
  console.log(`  Eufemia ${meta.eufemiaVersion}  ·  ${meta.counts.primitiveTokens} primitive tokens · ${meta.counts.icons} icons · ${meta.counts.components} components`)
  console.log(`  Themes: ${availableThemes.join(', ')}`)
  console.log(`  Available versions: ${versions.join(', ')}\n`)
})
