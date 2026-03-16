#!/usr/bin/env node
// start.js — starts Eufemia MCP server + Cloudflare Tunnel for Figma Make

import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 3456

let tunnelStarted = false

function startServer() {
  console.log('Starting Eufemia MCP server...\n')
  const server = spawn('node', [path.join(__dirname, 'server.js')], {
    stdio: 'inherit',
    env: { ...process.env, PORT }
  })

  server.on('close', code => {
    console.log(`\nServer exited (code ${code}), restarting in 2s...`)
    setTimeout(startServer, 2000)
  })

  if (!tunnelStarted) {
    tunnelStarted = true
    setTimeout(startTunnel, 5000)
  }
}

function startTunnel() {
  console.log('\nStarting Cloudflare Tunnel...')
  const cf = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`, '--no-autoupdate', '--protocol', 'http2'], {
    stdio: ['ignore', 'pipe', 'pipe']
  })

  function onData(data) {
    const text = data.toString()
    const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
    if (match) {
      const url = match[0]
      console.log('\n' + '═'.repeat(60))
      console.log('🔗 Public URL:', url)
      console.log('═'.repeat(60))
      console.log('\nTo connect in Figma Make:')
      console.log('  1. Open Figma → Make tab')
      console.log('  2. Click "Connectors" → "Create connector"')
      console.log(`  3. Paste: ${url}/sse`)
      console.log('\nTry prompting: "Create a login form using DNB\'s design system"')
      console.log('═'.repeat(60) + '\n')
    }
  }

  cf.stdout.on('data', onData)
  cf.stderr.on('data', onData)

  cf.on('close', code => {
    console.log('Cloudflare Tunnel exited:', code)
    process.exit(code ?? 0)
  })
}

startServer()

process.on('SIGINT', () => {
  console.log('\nShutting down...')
  process.exit(0)
})
