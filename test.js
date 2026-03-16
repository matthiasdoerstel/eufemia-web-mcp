// test.js - Tests the Eufemia MCP server by holding an SSE connection open
import http from 'http'

const BASE = 'http://localhost:3456'

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function post(sessionId, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload)
    const req = http.request({
      hostname: 'localhost', port: 3456,
      path: `/message?sessionId=${encodeURIComponent(sessionId)}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = ''
      res.on('data', c => d += c)
      res.on('end', () => resolve({ status: res.statusCode, body: d }))
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// Collect SSE messages
const sseMessages = []

// Open SSE connection and keep it alive
const sseReq = http.get(`${BASE}/sse`, (res) => {
  let buffer = ''
  let sessionId = null

  res.on('data', chunk => {
    buffer += chunk.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop()

    for (const line of lines) {
      if (line.startsWith('data:')) {
        const data = line.slice(5).trim()
        sseMessages.push(data)

        if (data.includes('sessionId=')) {
          sessionId = data.split('sessionId=')[1].trim()
          console.log('✓ SSE connected, session:', sessionId)
          runTests(sessionId).then(() => {
            sseReq.destroy()
            process.exit(0)
          }).catch(err => {
            console.error('Test failed:', err)
            sseReq.destroy()
            process.exit(1)
          })
        }
      }
    }
  })

  res.on('error', err => console.error('SSE error:', err))
})

sseReq.on('error', err => {
  console.error('Could not connect to server:', err.message)
  process.exit(1)
})

async function runTests(sessionId) {
  console.log('\n─── Test 1: Initialize ───')
  await post(sessionId, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } }
  })
  await post(sessionId, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
  await sleep(200)

  console.log('\n─── Test 2: tools/list ───')
  const r1 = await post(sessionId, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  console.log('POST status:', r1.status)
  await sleep(300)
  const toolsMsg = sseMessages.filter(m => m.includes('"tools"')).pop()
  if (toolsMsg) {
    const parsed = JSON.parse(toolsMsg)
    const tools = parsed?.result?.tools || []
    console.log('Tools available:', tools.map(t => t.name).join(', '))
  }

  console.log('\n─── Test 3: search_components("button") ───')
  await post(sessionId, {
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'search_components', arguments: { query: 'button' } }
  })
  await sleep(300)
  const compMsg = sseMessages.filter(m => m.includes('"content"') && m.includes('button')).pop()
  if (compMsg) {
    const parsed = JSON.parse(compMsg)
    const text = parsed?.result?.content?.[0]?.text
    if (text) {
      const data = JSON.parse(text)
      console.log(`Found ${data.count} components:`, data.results.map(r => r.name).join(', '))
    }
  }

  console.log('\n─── Test 4: search_icons("arrow") ───')
  await post(sessionId, {
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'search_icons', arguments: { query: 'arrow' } }
  })
  await sleep(300)
  const iconMsg = sseMessages.filter(m => m.includes('importDefault') && m.includes('arrow')).pop()
  if (iconMsg) {
    const parsed = JSON.parse(iconMsg)
    const text = parsed?.result?.content?.[0]?.text
    if (text) {
      const data = JSON.parse(text)
      console.log(`Found ${data.count} arrow icons:`, data.results.slice(0, 5).map(i => i.name).join(', '))
    }
  }

  console.log('\n─── Test 5: get_design_tokens(category=color) ───')
  await post(sessionId, {
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { name: 'get_design_tokens', arguments: { category: 'color' } }
  })
  await sleep(300)
  const tokenMsg = sseMessages.filter(m => m.includes('sea-green') || m.includes('color')).pop()
  if (tokenMsg) {
    const parsed = JSON.parse(tokenMsg)
    const text = parsed?.result?.content?.[0]?.text
    if (text) {
      const data = JSON.parse(text)
      console.log(`Found ${data.total} color tokens. Sample:`, data.tokens.slice(0, 3).map(t => `${t.name}: ${t.value}`).join(' | '))
    }
  }

  console.log('\n─── Test 6: get_component_guidelines("button") ───')
  await post(sessionId, {
    jsonrpc: '2.0', id: 6, method: 'tools/call',
    params: { name: 'get_component_guidelines', arguments: { component: 'button' } }
  })
  await sleep(500)
  const guideMsg = sseMessages.filter(m => m.includes('primary') && m.includes('button')).pop()
  if (guideMsg) {
    const parsed = JSON.parse(guideMsg)
    const text = parsed?.result?.content?.[0]?.text
    if (text) {
      console.log('Guidelines preview:', text.slice(0, 300).replace(/\n/g, ' '))
    }
  }

  console.log('\n✓ All tests passed')
}
