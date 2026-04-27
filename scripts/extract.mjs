#!/usr/bin/env node
/**
 * Eufemia MCP data extractor
 * Usage: node scripts/extract.mjs --version 11.0.0
 *
 * Installs @dnb/eufemia at the given version, extracts all tokens, icons,
 * and component data, and writes versioned JSON to data/v{major}/.
 *
 * Covers: components, elements, layout, extensions (forms, payment-card,
 * vipps-wallet-button) including all Form/Field/Iterate/Value/Wizard sub-components.
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

if (!versionArg || !/^\d+\.\d+\.\d+/.test(versionArg)) {
  console.error('Usage: node scripts/extract.mjs --version 11.0.0')
  process.exit(1)
}

const major = versionArg.split('.')[0]
const tag = `v${versionArg}`
const outputDir = path.join(__dirname, '..', 'data', `v${major}`)

const DOCS_BASE = 'packages/dnb-design-system-portal/src/docs/uilib'
const SRC_BASE = 'packages/dnb-eufemia/src'
const GITHUB_RAW = `https://raw.githubusercontent.com/dnbexperience/eufemia/${tag}`
const GITHUB_API = `https://api.github.com/repos/dnbexperience/eufemia`

const headers = {}
if (process.env.GITHUB_TOKEN) {
  headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`
}

// ─── GitHub helpers ───────────────────────────────────────────────────────────

async function ghContents(path) {
  const res = await fetch(`${GITHUB_API}/contents/${path}?ref=${tag}`, { headers })
  if (!res.ok) return null
  const data = await res.json()
  return Array.isArray(data) ? data : null
}

async function ghRaw(path) {
  const res = await fetch(`${GITHUB_RAW}/${path}`)
  return res.ok ? res.text() : null
}

async function listDirs(path) {
  const items = await ghContents(path)
  if (!items) return []
  return items.filter(i => i.type === 'dir').map(i => i.name)
}

// ─── Section definitions ──────────────────────────────────────────────────────

// Flat sections: each directory in docsPath is a component
const FLAT_SECTIONS = [
  {
    id: 'components',
    docsPath: `${DOCS_BASE}/components`,
    srcPath: `${SRC_BASE}/components`,
    importBase: '@dnb/eufemia',
  },
  {
    id: 'elements',
    docsPath: `${DOCS_BASE}/elements`,
    srcPath: `${SRC_BASE}/elements`,
    importBase: '@dnb/eufemia/elements',
    exclude: ['unstyled'],
  },
  {
    id: 'layout',
    docsPath: `${DOCS_BASE}/layout`,
    srcPath: `${SRC_BASE}/components`,
    importBase: '@dnb/eufemia',
    exclude: ['assets'],
  },
]

// Single-component extensions (no subdirectory listing needed)
const SINGLE_EXTENSIONS = [
  {
    id: 'payment-card',
    docsPath: `${DOCS_BASE}/extensions/payment-card`,
    srcPath: `${SRC_BASE}/extensions/payment-card`,
    importBase: '@dnb/eufemia/extensions/payment-card',
    name: 'payment-card',
  },
  {
    id: 'vipps-wallet-button',
    docsPath: `${DOCS_BASE}/extensions/vipps-wallet-button`,
    srcPath: `${SRC_BASE}/extensions/vipps-wallet-button`,
    importBase: '@dnb/eufemia/extensions/vipps-wallet-button',
    name: 'vipps-wallet-button',
  },
]

// Forms: namespaces with sub-components
// Field is split across base-fields/ and feature-fields/ in the docs portal
const FORMS_NAMESPACES = [
  { name: 'Form',    docsPaths: ['Form'] },
  { name: 'Field',   docsPaths: ['base-fields', 'feature-fields'] },
  { name: 'Iterate', docsPaths: ['Iterate'] },
  { name: 'Value',   docsPaths: ['Value'] },
  { name: 'Wizard',  docsPaths: ['Wizard'] },
]
// Skip internal/utility directories that aren't usable components
const FORMS_SKIP = new Set([
  'style', 'hooks', 'stories', 'Context', 'DataContext',
  'Element', 'Appearance', 'Snapshot', 'Composition',
  'Indeterminate', 'Provider', 'more-fields',
])

// ─── Install package ──────────────────────────────────────────────────────────

const tmpDir = mkdtempSync(path.join(tmpdir(), 'eufemia-extract-'))
console.log(`\nInstalling @dnb/eufemia@${versionArg} into ${tmpDir}...`)
execSync(`npm install @dnb/eufemia@${versionArg} --prefix ${tmpDir} --no-save --silent`, { stdio: 'inherit' })
const pkgDir = path.join(tmpDir, 'node_modules', '@dnb', 'eufemia')
console.log('  Done.')

// ─── Extract: tokens ──────────────────────────────────────────────────────────

console.log('\nExtracting tokens...')

function parseCssTokens(filePath) {
  if (!filePath || !existsSync(filePath)) return []
  const css = readFileSync(filePath, 'utf-8')
  const results = []
  const regex = /--([a-z0-9][a-z0-9-]+):\s*([^;]+);/g
  let m
  while ((m = regex.exec(css)) !== null) {
    results.push({ name: '--' + m[1], value: m[2].trim() })
  }
  return results
}

const THEMES = ['ui', 'sbanken', 'eiendom', 'carnegie']
const THEME_DIR_ALIASES = { ui: ['ui', 'theme-ui'] }

function findThemeDir(theme) {
  const aliases = THEME_DIR_ALIASES[theme] || [theme]
  for (const alias of aliases) {
    const p = path.join(pkgDir, 'style/themes', alias)
    if (existsSync(p)) return p
  }
  return null
}

const defaultThemeDir = findThemeDir('ui')
if (!defaultThemeDir) throw new Error('Could not find ui theme directory in package')

const primitiveTokens = parseCssTokens(path.join(defaultThemeDir, 'ui-theme-properties.css'))

const themeTokens = {}
for (const theme of THEMES) {
  const dir = findThemeDir(theme)
  if (!dir) {
    console.log(`  [skip] theme "${theme}" not found`)
    continue
  }
  const basisFile = path.join(dir, `${theme}-theme-basis.css`)
  const scale = parseCssTokens(basisFile)
  const semantic = parseCssTokens(path.join(dir, 'tokens.scss'))
  const semanticDark = parseCssTokens(path.join(dir, 'tokens-dark.scss'))
  themeTokens[theme] = { scale, semantic, semanticDark }
  console.log(`  ${theme}: ${scale.length} scale · ${semantic.length} semantic · ${semanticDark.length} dark`)
}

const scaleTokens = themeTokens.ui?.scale ?? []
const semanticTokens = themeTokens.ui?.semantic ?? []
const semanticTokensDark = themeTokens.ui?.semanticDark ?? []
console.log(`  ${primitiveTokens.length} primitive tokens (ui only)`)

// ─── Extract: icons ───────────────────────────────────────────────────────────

console.log('Extracting icons...')
const iconsDir = path.join(pkgDir, 'icons/dnb')
const allIconFiles = readdirSync(iconsDir)
  .filter(f => f.endsWith('.js') && !f.endsWith('.map') && !f.startsWith('index'))
  .map(f => f.replace('.js', ''))
const iconSet = new Set(allIconFiles)
const icons = allIconFiles
  .filter(n => !n.endsWith('_medium'))
  .map(name => ({ name, hasMedium: iconSet.has(`${name}_medium`) }))
console.log(`  ${icons.length} icons`)

// ─── Fetch helpers ────────────────────────────────────────────────────────────

function cleanGuidelines(text) {
  return text
    .replace(/^---[\s\S]*?---\s*/m, '')
    .replace(/^import\s[\s\S]*?(?:from\s['"][^'"]+['"])\s*$/gm, '')
    .replace(/^import .+\n/gm, '')
    .replace(/<[A-Z][A-Za-z]+\s*\/>/g, '[example]')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function cleanCode(text) {
  return text
    .replace(/import ComponentBox.*\n/g, '')
    .replace(/import.*dnb-design-system-portal.*\n/g, '')
    .replace(/import.*VisibilityByTheme.*\n/g, '')
    .replace(/import.*Theme.*\n/g, '')
    .replace(/<ComponentBox[^>]*>/g, '')
    .replace(/<\/ComponentBox>/g, '')
    .replace(/\/src\//g, '/')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function extractProps(docs) {
  const match = docs.match(/export const \w+Properties[^=]*=\s*(\{[\s\S]+\})/)
  if (!match) return []
  const propRegex = /['"]?([\w-]+)['"]?\s*:\s*\{[^}]*doc:\s*['"`]([\s\S]*?)['"`][^}]*type:\s*(\[[^\]]+\]|'[^']*'|"[^"]*")[^}]*status:\s*'([^']+)'/g
  const props = []
  let pm
  while ((pm = propRegex.exec(match[1])) !== null) {
    props.push({ name: pm[1], status: pm[4], type: pm[3], description: pm[2] })
  }
  return props
}

async function fetchComponentData({ docsPath, srcPath, name, importBase, section, namespace }) {
  const pascal = name.split('-').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('')

  const [guidelinesRaw, codeRaw, docsRaw] = await Promise.all([
    ghRaw(`${docsPath}/${name}/info.mdx`),
    ghRaw(`${docsPath}/${name}/Examples.tsx`),
    ghRaw(`${srcPath}/${name}/${pascal}Docs.ts`),
  ])

  // Skip entirely if nothing was found
  if (!guidelinesRaw && !codeRaw && !docsRaw) return null

  const entry = { name, section, importBase }
  if (namespace) entry.namespace = namespace

  if (guidelinesRaw) entry.guidelines = cleanGuidelines(guidelinesRaw)
  if (codeRaw) entry.code = cleanCode(codeRaw)
  if (docsRaw) {
    const props = extractProps(docsRaw)
    if (props.length > 0) entry.props = props
  }

  return entry
}

// ─── Fetch: flat sections ─────────────────────────────────────────────────────

console.log('\nFetching component data...')
const components = {}
let total = 0

for (const section of FLAT_SECTIONS) {
  const names = await listDirs(section.docsPath)
  const filtered = names.filter(n => !section.exclude?.includes(n))
  console.log(`\n  [${section.id}] ${filtered.length} entries`)

  for (const name of filtered) {
    const data = await fetchComponentData({
      docsPath: section.docsPath,
      srcPath: section.srcPath,
      name,
      importBase: section.importBase,
      section: section.id,
    })
    if (data) {
      components[name] = data
      total++
    }
    process.stdout.write('.')
  }
}

// ─── Fetch: single extensions ─────────────────────────────────────────────────

console.log(`\n\n  [extensions] ${SINGLE_EXTENSIONS.length} entries`)
for (const ext of SINGLE_EXTENSIONS) {
  const data = await fetchComponentData({
    docsPath: ext.docsPath,
    srcPath: ext.srcPath,
    name: ext.name,
    importBase: ext.importBase,
    section: 'extensions',
  })
  if (data) {
    components[ext.name] = data
    total++
  }
  process.stdout.write('.')
}

// ─── Fetch: forms namespaces ──────────────────────────────────────────────────

console.log('\n\n  [forms] enumerating namespaces...')
const FORMS_DOCS_BASE = `${DOCS_BASE}/extensions/forms`
const FORMS_SRC_BASE = `${SRC_BASE}/extensions/forms`

// Also add top-level forms entry
const formsTopLevel = await fetchComponentData({
  docsPath: FORMS_DOCS_BASE,
  srcPath: FORMS_SRC_BASE,
  name: 'forms',
  importBase: '@dnb/eufemia/extensions/forms',
  section: 'extensions',
})
// forms/info.mdx is at the root, not in a subdir — fetch directly
const formsInfoRaw = await ghRaw(`${FORMS_DOCS_BASE}/info.mdx`)
if (formsInfoRaw) {
  components['forms'] = {
    name: 'forms',
    section: 'extensions',
    importBase: '@dnb/eufemia/extensions/forms',
    guidelines: cleanGuidelines(formsInfoRaw),
  }
  total++
}

let formsCount = 0
for (const { name: namespace, docsPaths } of FORMS_NAMESPACES) {
  // Collect sub-components with the docsSubPath they came from
  const subComponents = []
  for (const docsSubPath of docsPaths) {
    const subDirs = await listDirs(`${FORMS_DOCS_BASE}/${docsSubPath}`)
    for (const n of subDirs) {
      if (/^[A-Z]/.test(n) && !FORMS_SKIP.has(n)) {
        subComponents.push({ subName: n, docsSubPath })
      }
    }
  }
  console.log(`    ${namespace}: ${subComponents.length} sub-components`)

  for (const { subName, docsSubPath } of subComponents) {
    const key = `forms/${namespace.toLowerCase()}/${subName.toLowerCase()}`
    const docsBase = `${FORMS_DOCS_BASE}/${docsSubPath}/${subName}`

    const [infoRaw, codeRaw, docsRaw] = await Promise.all([
      ghRaw(`${docsBase}/info.mdx`),
      ghRaw(`${docsBase}/Examples.tsx`),
      ghRaw(`${FORMS_SRC_BASE}/${namespace}/${subName}/${subName}Docs.ts`),
    ])

    if (!infoRaw && !codeRaw && !docsRaw) {
      process.stdout.write('.')
      continue
    }

    const entry = {
      name: `${namespace}.${subName}`,
      section: 'extensions/forms',
      importBase: '@dnb/eufemia/extensions/forms',
      namespace,
      subName,
    }

    if (infoRaw) entry.guidelines = cleanGuidelines(infoRaw)
    if (codeRaw) entry.code = cleanCode(codeRaw)
    if (docsRaw) {
      const props = extractProps(docsRaw)
      if (props.length > 0) entry.props = props
    }

    components[key] = entry
    total++
    formsCount++
    process.stdout.write('.')
  }
}
console.log(`\n  Forms total: ${formsCount} sub-components`)

// ─── Write output ─────────────────────────────────────────────────────────────

mkdirSync(outputDir, { recursive: true })

const themeCounts = {}
for (const [theme, data] of Object.entries(themeTokens)) {
  themeCounts[theme] = {
    scale: data.scale.length,
    semantic: data.semantic.length,
    semanticDark: data.semanticDark.length,
  }
  writeFileSync(path.join(outputDir, `tokens-scale-${theme}.json`), JSON.stringify(data.scale, null, 2))
  writeFileSync(path.join(outputDir, `tokens-semantic-${theme}.json`), JSON.stringify(data.semantic, null, 2))
  writeFileSync(path.join(outputDir, `tokens-semantic-dark-${theme}.json`), JSON.stringify(data.semanticDark, null, 2))
}

writeFileSync(path.join(outputDir, 'meta.json'), JSON.stringify({
  eufemiaVersion: versionArg,
  extractedAt: new Date().toISOString(),
  themes: Object.keys(themeTokens),
  counts: {
    primitiveTokens: primitiveTokens.length,
    icons: icons.length,
    components: total,
    themes: themeCounts,
  },
}, null, 2))

// Backward-compat aliases
writeFileSync(path.join(outputDir, 'tokens-scale.json'), JSON.stringify(scaleTokens, null, 2))
writeFileSync(path.join(outputDir, 'tokens-primitive.json'), JSON.stringify(primitiveTokens, null, 2))
writeFileSync(path.join(outputDir, 'tokens-semantic.json'), JSON.stringify(semanticTokens, null, 2))
writeFileSync(path.join(outputDir, 'tokens-semantic-dark.json'), JSON.stringify(semanticTokensDark, null, 2))
writeFileSync(path.join(outputDir, 'icons.json'), JSON.stringify(icons, null, 2))
writeFileSync(path.join(outputDir, 'components.json'), JSON.stringify(components, null, 2))

console.log(`\n✓ Extracted to ${outputDir}`)
console.log(`  eufemiaVersion : ${versionArg}`)
console.log(`  primitive      : ${primitiveTokens.length}`)
console.log(`  icons          : ${icons.length}`)
console.log(`  components     : ${total}`)
for (const [theme, counts] of Object.entries(themeCounts)) {
  console.log(`  ${theme.padEnd(10)}: ${counts.scale} scale · ${counts.semantic} semantic · ${counts.semanticDark} dark`)
}
