#!/usr/bin/env node
/**
 * Eufemia MCP data extractor
 * Usage: node scripts/extract.mjs --version 11.0.0
 *
 * Installs @dnb/eufemia at the given version, extracts all tokens, icons,
 * and component data, and writes versioned JSON to data/v{major}/.
 */

import { execSync } from 'child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ─── Args ─────────────────────────────────────────────────────────────────────

const versionIdx = process.argv.indexOf('--version')
const versionArg = versionIdx !== -1 ? process.argv[versionIdx + 1] : null

if (!versionArg) {
  console.error('Usage: node scripts/extract.mjs --version 11.0.0')
  process.exit(1)
}

const major = versionArg.split('.')[0]
const tag = `v${versionArg}`
const outputDir = path.join(__dirname, '..', 'data', `v${major}`)

const GITHUB_RAW = `https://raw.githubusercontent.com/dnbexperience/eufemia/${tag}`
const GITHUB_API = `https://api.github.com/repos/dnbexperience/eufemia`
const COMPONENTS_PATH = 'packages/dnb-design-system-portal/src/docs/uilib/components'

const headers = {}
if (process.env.GITHUB_TOKEN) {
  headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`
}

// ─── Install package ──────────────────────────────────────────────────────────

const tmpDir = mkdtempSync(path.join(tmpdir(), 'eufemia-extract-'))
console.log(`\nInstalling @dnb/eufemia@${versionArg} into ${tmpDir}...`)
execSync(`npm install @dnb/eufemia@${versionArg} --prefix ${tmpDir} --no-save --silent`, { stdio: 'inherit' })
const pkgDir = path.join(tmpDir, 'node_modules', '@dnb', 'eufemia')
console.log('  Done.')

// ─── Extract: tokens ──────────────────────────────────────────────────────────

console.log('\nExtracting tokens...')

function parseCssTokens(filePath) {
  if (!filePath) return []
  const css = readFileSync(filePath, 'utf-8')
  const results = []
  const regex = /--([a-z0-9][a-z0-9-]+):\s*([^;]+);/g
  let m
  while ((m = regex.exec(css)) !== null) {
    results.push({ name: '--' + m[1], value: m[2].trim() })
  }
  return results
}

function findFile(...candidates) {
  return candidates.find(p => existsSync(p)) || null
}

const themeDir = findFile(
  path.join(pkgDir, 'style/themes/ui'),
  path.join(pkgDir, 'style/themes/theme-ui')
)
if (!themeDir) throw new Error('Could not find theme directory in package')

// Primitive tokens: --color-*, --spacing-*, etc. (legacy)
const primitiveTokens = parseCssTokens(path.join(themeDir, 'ui-theme-properties.css'))

// Scale tokens: --dnb-coldgreen-*, --dnb-greyscale-*, etc. (new in v11)
const scaleTokens = parseCssTokens(findFile(path.join(themeDir, 'ui-theme-basis.css')))

// Semantic tokens: --token-color-background-*, etc. (new in v11)
const semanticTokens = parseCssTokens(findFile(path.join(themeDir, 'tokens.scss')))

// Semantic dark mode overrides (new in v11)
const semanticTokensDark = parseCssTokens(findFile(path.join(themeDir, 'tokens-dark.scss')))

console.log(`  ${scaleTokens.length} scale tokens`)
console.log(`  ${primitiveTokens.length} primitive tokens`)
console.log(`  ${semanticTokens.length} semantic tokens`)
console.log(`  ${semanticTokensDark.length} semantic dark tokens`)

// ─── Extract: icons ───────────────────────────────────────────────────────────

console.log('Extracting icons...')
const iconsDir = path.join(pkgDir, 'icons/dnb')
const allIconFiles = readdirSync(iconsDir)
  .filter(f => f.endsWith('.js') && !f.endsWith('.map') && !f.startsWith('index'))
  .map(f => f.replace('.js', ''))
const iconSet = new Set(allIconFiles)
const icons = allIconFiles
  .filter(n => !n.endsWith('_medium'))
  .map(name => ({
    name,
    hasMedium: iconSet.has(`${name}_medium`)
  }))
console.log(`  ${icons.length} icons`)

// ─── Fetch: component list ────────────────────────────────────────────────────

console.log(`\nFetching component list from GitHub (${tag})...`)
let componentList = []
try {
  const res = await fetch(`${GITHUB_API}/contents/${COMPONENTS_PATH}?ref=${tag}`, { headers })
  const items = await res.json()
  if (Array.isArray(items)) {
    componentList = items.filter(i => i.type === 'dir').map(i => i.name)
    console.log(`  ${componentList.length} components found`)
  } else {
    throw new Error(`Unexpected response: ${JSON.stringify(items).slice(0, 100)}`)
  }
} catch (e) {
  console.error(`  Failed to fetch component list: ${e.message}`)
  process.exit(1)
}

// ─── Fetch: component data ────────────────────────────────────────────────────

console.log('\nFetching component data...')
const components = {}

for (const name of componentList) {
  const pascal = name.split('-').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('')

  const [guidelinesRes, examplesRes, docsRes] = await Promise.all([
    fetch(`${GITHUB_RAW}/${COMPONENTS_PATH}/${name}/info.mdx`),
    fetch(`${GITHUB_RAW}/${COMPONENTS_PATH}/${name}/Examples.tsx`),
    fetch(`${GITHUB_RAW}/packages/dnb-eufemia/src/components/${name}/${pascal}Docs.ts`)
  ])

  components[name] = { name }

  if (guidelinesRes.ok) {
    let text = await guidelinesRes.text()
    text = text
      .replace(/^---[\s\S]*?---\s*/m, '')
      .replace(/^import\s[\s\S]*?(?:from\s['"][^'"]+['"])\s*$/gm, '')
      .replace(/^import .+\n/gm, '')
      .replace(/<[A-Z][A-Za-z]+\s*\/>/g, '[example]')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    components[name].guidelines = text
  }

  if (examplesRes.ok) {
    let code = await examplesRes.text()
    code = code
      .replace(/import ComponentBox.*\n/g, '')
      .replace(/import.*dnb-design-system-portal.*\n/g, '')
      .replace(/import.*VisibilityByTheme.*\n/g, '')
      .replace(/import.*Theme.*\n/g, '')
      .replace(/<ComponentBox[^>]*>/g, '')
      .replace(/<\/ComponentBox>/g, '')
      .replace(/\/src\//g, '/')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    components[name].code = code
  }

  if (docsRes.ok) {
    let docs = await docsRes.text()
    const match = docs.match(/export const \w+Properties[^=]*=\s*(\{[\s\S]+\})/)
    if (match) {
      const propRegex = /['"]?([\w-]+)['"]?\s*:\s*\{[^}]*doc:\s*['"`]([\s\S]*?)['"`][^}]*type:\s*(\[[^\]]+\]|'[^']*'|"[^"]*")[^}]*status:\s*'([^']+)'/g
      const props = []
      let pm
      while ((pm = propRegex.exec(match[1])) !== null) {
        props.push({ name: pm[1], status: pm[4], type: pm[3], description: pm[2] })
      }
      if (props.length > 0) components[name].props = props
    }
  }

  process.stdout.write('.')
}
console.log('')

// ─── Write output ─────────────────────────────────────────────────────────────

mkdirSync(outputDir, { recursive: true })

writeFileSync(path.join(outputDir, 'meta.json'), JSON.stringify({
  eufemiaVersion: versionArg,
  extractedAt: new Date().toISOString(),
  counts: {
    scaleTokens: scaleTokens.length,
    primitiveTokens: primitiveTokens.length,
    semanticTokens: semanticTokens.length,
    semanticTokensDark: semanticTokensDark.length,
    icons: icons.length,
    components: componentList.length
  }
}, null, 2))

writeFileSync(path.join(outputDir, 'tokens-scale.json'), JSON.stringify(scaleTokens, null, 2))
writeFileSync(path.join(outputDir, 'tokens-primitive.json'), JSON.stringify(primitiveTokens, null, 2))
writeFileSync(path.join(outputDir, 'tokens-semantic.json'), JSON.stringify(semanticTokens, null, 2))
writeFileSync(path.join(outputDir, 'tokens-semantic-dark.json'), JSON.stringify(semanticTokensDark, null, 2))
writeFileSync(path.join(outputDir, 'icons.json'), JSON.stringify(icons, null, 2))
writeFileSync(path.join(outputDir, 'components.json'), JSON.stringify(components, null, 2))

console.log(`\n✓ Extracted to ${outputDir}`)
console.log(`  eufemiaVersion    : ${versionArg}`)
console.log(`  scale tokens      : ${scaleTokens.length}`)
console.log(`  primitive tokens  : ${primitiveTokens.length}`)
console.log(`  semantic tokens   : ${semanticTokens.length}`)
console.log(`  semantic dark     : ${semanticTokensDark.length}`)
console.log(`  icons             : ${icons.length}`)
console.log(`  components        : ${componentList.length}`)
