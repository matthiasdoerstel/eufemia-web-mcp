import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import express from 'express'
import cors from 'cors'
import { readFileSync, readdirSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { z } from 'zod'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ─── Data: Design Tokens ──────────────────────────────────────────────────────

const eufemiaPath = path.resolve(__dirname, 'node_modules/@dnb/eufemia')
const cssPath = path.join(eufemiaPath, 'style/themes/theme-ui/ui-theme-properties.css')
const css = readFileSync(cssPath, 'utf-8')

const allTokens = []
const tokenRegex = /--([a-z0-9][a-z0-9-]+):\s*([^;]+);/g
let m
while ((m = tokenRegex.exec(css)) !== null) {
  allTokens.push({ name: '--' + m[1], value: m[2].trim() })
}

// ─── Data: Icons ──────────────────────────────────────────────────────────────

const iconsDir = path.join(eufemiaPath, 'icons/dnb')
const allIconFiles = readdirSync(iconsDir)
  .filter(f => f.endsWith('.js') && !f.endsWith('.map') && !f.startsWith('index'))
  .map(f => f.replace('.js', ''))

const iconSet = new Set(allIconFiles)
const baseIcons = allIconFiles.filter(n => !n.endsWith('_medium'))

// ─── Data: Component list (loaded from GitHub at startup) ─────────────────────

const GITHUB_RAW = 'https://raw.githubusercontent.com/dnbexperience/eufemia/main'
const GITHUB_API = 'https://api.github.com/repos/dnbexperience/eufemia'
const COMPONENTS_PATH = 'packages/dnb-design-system-portal/src/docs/uilib/components'

// Fallback component list if GitHub API is rate-limited
const FALLBACK_COMPONENTS = [
  'accordion', 'anchor', 'autocomplete', 'avatar', 'badge', 'breadcrumb',
  'button', 'card', 'checkbox', 'date-picker', 'dialog', 'drawer',
  'dropdown', 'form-row', 'form-set', 'form-status', 'global-status',
  'help-button', 'icon', 'icon-primary', 'info-card', 'input', 'input-masked',
  'list', 'logo', 'modal', 'number-format', 'pagination', 'payment-card',
  'progress-indicator', 'radio', 'section', 'skeleton', 'slider',
  'space', 'step-indicator', 'table', 'tabs', 'tag', 'textarea',
  'timeline', 'toggle-button', 'tooltip', 'upload', 'visually-hidden'
]

let componentList = []

async function loadComponentList() {
  try {
    const headers = {}
    if (process.env.GITHUB_TOKEN) {
      headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`
    }
    const res = await fetch(`${GITHUB_API}/contents/${COMPONENTS_PATH}`, { headers })
    const items = await res.json()
    if (!Array.isArray(items)) {
      console.warn(`⚠ GitHub API rate limited — using fallback component list (${FALLBACK_COMPONENTS.length} components)`)
      componentList = FALLBACK_COMPONENTS
      return
    }
    componentList = items.filter(i => i.type === 'dir').map(i => i.name)
    console.log(`✓ ${componentList.length} components loaded from GitHub`)
  } catch (err) {
    console.warn(`⚠ Could not load component list: ${err.message} — using fallback`)
    componentList = FALLBACK_COMPONENTS
  }
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer(
  { name: 'eufemia-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } }
)

// Tool: get_design_tokens
server.tool(
  'get_design_tokens',
  'Get DNB Eufemia design tokens: colors, spacing, typography, shadows, animation values. Filter by category or search by name/value.',
  {
    category: z.string().optional().describe('Filter by category prefix: "color", "spacing", "font", "line-height", "shadow", "animation"'),
    search: z.string().optional().describe('Search by token name or value (e.g. "sea-green", "#007272", "0.25rem")')
  },
  async ({ category, search }) => {
    let tokens = allTokens

    if (category) {
      const cat = category.toLowerCase()
      tokens = tokens.filter(t =>
        t.name.startsWith(`--${cat}-`) || t.name.includes(`-${cat}-`)
      )
    }

    if (search) {
      const q = search.toLowerCase()
      tokens = tokens.filter(t =>
        t.name.toLowerCase().includes(q) || t.value.toLowerCase().includes(q)
      )
    }

    const result = {
      total: tokens.length,
      note: tokens.length > 200 ? 'Results truncated to 200 — use category/search to narrow down' : undefined,
      tokens: tokens.slice(0, 200)
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
    const name = component.toLowerCase().replace(/\s+/g, '-')
    const url = `${GITHUB_RAW}/${COMPONENTS_PATH}/${name}/info.mdx`

    const res = await fetch(url)
    if (!res.ok) {
      const close = componentList.filter(c => c.includes(name) || name.includes(c))
      const suggestion = close.length > 0 ? ` Did you mean: ${close.slice(0, 5).join(', ')}?` : ' Use search_components to find available components.'
      return {
        content: [{ type: 'text', text: `Component "${name}" not found (HTTP ${res.status}).${suggestion}` }],
        isError: true
      }
    }

    let text = await res.text()
    // Clean MDX: strip frontmatter and imports
    text = text
      .replace(/^---[\s\S]*?---\s*/m, '')
      .replace(/^import\s[\s\S]*?(?:from\s['"][^'"]+['"])\s*$/gm, '')  // multi-line imports
      .replace(/^import .+\n/gm, '')                                    // single-line imports
      .replace(/<[A-Z][A-Za-z]+\s*\/>/g, '[example]')
      .replace(/\n{3,}/g, '\n\n')
      .trim()

    return { content: [{ type: 'text', text }] }
  }
)

// Tool: get_component_code
server.tool(
  'get_component_code',
  'Get the real React implementation for an Eufemia component. IMPORTANT: You MUST import and use the component directly from @dnb/eufemia — do NOT recreate, reimplement, or restyle it with custom CSS. The component is already fully styled. Just use the import and JSX examples exactly as shown. Do not wrap it in a custom component.',
  {
    component: z.string().describe('Component name in kebab-case (e.g. "button", "input", "modal", "date-picker")')
  },
  async ({ component }) => {
    const name = component.toLowerCase().replace(/\s+/g, '-')

    // Derive PascalCase component name (e.g. "date-picker" → "DatePicker")
    const pascal = name.split('-').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('')

    // Fetch Examples.tsx (real JSX usage) and ButtonDocs.ts (props API) in parallel
    const examplesUrl = `${GITHUB_RAW}/${COMPONENTS_PATH}/${name}/Examples.tsx`
    const docsUrl = `${GITHUB_RAW}/packages/dnb-eufemia/src/components/${name}/${pascal}Docs.ts`

    const [examplesRes, docsRes] = await Promise.all([
      fetch(examplesUrl),
      fetch(docsUrl)
    ])

    const sections = []

    // --- Import line ---
    sections.push(`## Import\n\`\`\`tsx\nimport { ${pascal} } from '@dnb/eufemia'\n\`\`\`\n\n> **IMPORTANT:** Use this import directly. Do NOT recreate or reimplement this component with custom CSS or wrappers. It is already fully styled by Eufemia.`)

    // --- Examples ---
    if (examplesRes.ok) {
      let code = await examplesRes.text()
      // Strip internal imports, keep only the component examples
      code = code
        .replace(/import ComponentBox.*\n/g, '')
        .replace(/import.*dnb-design-system-portal.*\n/g, '')
        .replace(/import.*VisibilityByTheme.*\n/g, '')
        .replace(/import.*Theme.*\n/g, '')
        .replace(/<ComponentBox[^>]*>/g, '')
        .replace(/<\/ComponentBox>/g, '')
        .replace(/\/src\//g, '/')  // normalise src paths
        .replace(/\n{3,}/g, '\n\n')
        .trim()
      sections.push(`## Code Examples\n\`\`\`tsx\n${code}\n\`\`\``)
    } else {
      sections.push(`## Code Examples\nNot available for "${name}".`)
    }

    // --- Props API ---
    if (docsRes.ok) {
      let docs = await docsRes.text()
      // Extract just the properties object content
      const match = docs.match(/export const \w+Properties[^=]*=\s*(\{[\s\S]+\})/)
      if (match) {
        // Parse prop names + doc strings into a readable table
        const propRegex = /['"]?([\w-]+)['"]?\s*:\s*\{[^}]*doc:\s*['"`]([\s\S]*?)['"`][^}]*type:\s*(\[[^\]]+\]|'[^']*'|"[^"]*")[^}]*status:\s*'([^']+)'/g
        const props = []
        let pm
        while ((pm = propRegex.exec(match[1])) !== null) {
          props.push(`| \`${pm[1]}\` | ${pm[4]} | ${pm[3].replace(/\n/g, ' ')} | ${pm[2].replace(/\n/g, ' ')} |`)
        }
        if (props.length > 0) {
          sections.push(`## Props\n| Prop | Status | Type | Description |\n|------|--------|------|-------------|\n${props.join('\n')}`)
        }
      } else {
        sections.push(`## Props\n\`\`\`ts\n${docs.slice(0, 3000)}\n\`\`\``)
      }
    } else {
      sections.push(`## Props\nNot available for "${name}". Check https://eufemia.dnb.no/uilib/components/${name}/properties/`)
    }

    return { content: [{ type: 'text', text: sections.join('\n\n') }] }
  }
)

// Tool: search_components
server.tool(
  'search_components',
  'Search available Eufemia components by name or keyword. Returns component names with links to guidelines and documentation.',
  {
    query: z.string().describe('Search query (e.g. "button", "form", "nav", "table", "date", "input")')
  },
  async ({ query }) => {
    const q = query.toLowerCase()
    const matches = componentList
      .filter(name => name.includes(q))
      .map(name => ({
        name,
        guidelines: `Use get_component_guidelines with component="${name}"`,
        docs: `https://eufemia.dnb.no/uilib/components/${name}/`
      }))

    const result = { query, count: matches.length, results: matches }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
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
    const matches = baseIcons
      .filter(name => name.includes(q))
      .slice(0, 60)
      .map(name => ({
        name,
        sizes: iconSet.has(`${name}_medium`)
          ? ['default (16px)', 'medium (24px)']
          : ['default (16px)'],
        importDefault: `import ${toCamelCase(name)} from '@dnb/eufemia/icons/dnb/${name}'`,
        importMedium: iconSet.has(`${name}_medium`)
          ? `import ${toCamelCase(name + '_medium')} from '@dnb/eufemia/icons/dnb/${name}_medium'`
          : null
      }))

    const result = {
      query,
      count: matches.length,
      note: matches.length === 0 ? 'No icons found. Try a shorter or different keyword.' : undefined,
      results: matches
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

function toCamelCase(str) {
  return str.replace(/(^[a-z])|_([a-z])/g, (_, a, b) => (a || b).toUpperCase())
}

// ─── HTTP + SSE Express App ───────────────────────────────────────────────────

const app = express()
app.use(cors())
app.use(express.json())

const sessions = {}

// Root redirect → useful if Figma Make hits the base URL without /sse
app.get('/', (req, res) => {
  res.redirect('/sse')
})

// Figma Make connects here via GET /sse
app.get('/sse', async (req, res) => {
  res.setHeader('X-Accel-Buffering', 'no')
  req.socket.setNoDelay(true)

  // Patch res.write to append 2KB padding after each SSE event to flush Zscaler's buffer
  const originalWrite = res.write.bind(res)
  res.write = (chunk, ...args) => {
    const str = chunk?.toString() || ''
    console.log(`← SSE write ${str.length} bytes: ${str.slice(0, 80).replace(/\n/g, '\\n')}`)
    if (!str.startsWith(':')) {
      return originalWrite(str + ': ' + ' '.repeat(16384) + '\n\n', ...args)
    }
    return originalWrite(chunk, ...args)
  }

  // Send keepalive every 15s to prevent proxy timeouts
  const keepalive = setInterval(() => originalWrite(': keepalive\n\n'), 15000)
  res.on('close', () => clearInterval(keepalive))

  const transport = new SSEServerTransport('/message', res)
  sessions[transport.sessionId] = transport

  res.on('close', () => {
    delete sessions[transport.sessionId]
    console.log(`↙ Session disconnected: ${transport.sessionId}`)
  })

  console.log(`↗ New session: ${transport.sessionId}`)
  await server.connect(transport)
})

// Figma Make posts tool calls here
app.post('/message', async (req, res) => {
  const sessionId = req.query.sessionId
  const transport = sessions[sessionId]
  console.log(`→ POST /message session=${sessionId} method=${req.body?.method}`)

  if (!transport) {
    return res.status(404).json({ error: `Session not found: ${sessionId}` })
  }

  await transport.handlePostMessage(req, res, req.body)
})

// Quick health / status check
app.get('/health', (_, res) => {
  res.json({
    status: 'ok',
    server: 'eufemia-mcp v0.1.0',
    tools: ['get_design_tokens', 'get_component_guidelines', 'get_component_code', 'search_components', 'search_icons'],
    data: {
      tokens: allTokens.length,
      icons: baseIcons.length,
      components: componentList.length
    }
  })
})

// ─── Keep alive ───────────────────────────────────────────────────────────────

process.on('uncaughtException', err => console.error('Uncaught exception:', err))
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err))

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3456

loadComponentList().then(() => {
  app.listen(PORT, () => {
    console.log(`\nEufemia MCP Server  http://localhost:${PORT}`)
    console.log(`  GET  /sse      → SSE stream (connect Figma Make here)`)
    console.log(`  POST /message  → Tool calls`)
    console.log(`  GET  /health   → Status\n`)
    console.log(`Data:  ${allTokens.length} tokens  ·  ${baseIcons.length} icons  ·  ${componentList.length} components`)
    console.log(`\nTo expose:  ngrok http ${PORT}`)
  })
})
