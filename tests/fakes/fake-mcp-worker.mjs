import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const workerId = process.env.FAKE_WORKER_ID ?? 'unknown-worker'
const mutationFile = process.env.FAKE_MUTATION_FILE
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value })
}

rl.on('line', (line) => {
  if (!line.trim()) return
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    result(message.id, {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: `fake-${workerId}`, version: '1.0.0' },
    })
    return
  }
  if (message.method === 'tools/list') {
    result(message.id, {
      tools: [
        { name: 'identify', description: 'Return fake worker id', inputSchema: { type: 'object', properties: {} } },
        { name: 'ambiguous_mutation', description: 'Mutate then exit without response', inputSchema: { type: 'object', properties: {} } },
      ],
    })
    return
  }
  if (message.method === 'tools/call' && message.params?.name === 'identify') {
    result(message.id, { content: [{ type: 'text', text: workerId }] })
    return
  }
  if (message.method === 'tools/call' && message.params?.name === 'ambiguous_mutation') {
    if (mutationFile) appendFileSync(mutationFile, `${workerId}\n`)
    setTimeout(() => process.exit(13), 5)
    return
  }
  if (message.id !== undefined && message.method) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Unknown method ${message.method}` } })
  }
})
