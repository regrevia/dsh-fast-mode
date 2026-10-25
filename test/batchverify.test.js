import assert from 'node:assert/strict'
import test from 'node:test'

import { autoSchedule, createAutoState, notePolicy, noteStep, noteTool } from '../src/auto.js'

/** Two clean reads, so no other reminder is due. */
function quietStart(state, agent) {
  noteStep(state, agent)
  noteTool(state, agent, { name: 'read', argsKey: 'a.js', chars: 10 })
  noteTool(state, agent, { name: 'read', argsKey: 'b.js', chars: 10 })
  noteStep(state, agent)
  noteTool(state, agent, { name: 'read', argsKey: 'c.js', chars: 10 })
  noteTool(state, agent, { name: 'read', argsKey: 'd.js', chars: 10 })
}

test('batch verification stays silent unless the config asked for it', () => {
  const state = createAutoState()
  notePolicy(state, 'a', {})
  quietStart(state, 'a')
  noteTool(state, 'a', { name: 'write', argsKey: 'x.js', chars: 10 })
  noteTool(state, 'a', { name: 'write', argsKey: 'y.js', chars: 10 })
  noteStep(state, 'a')
  assert.doesNotMatch(JSON.stringify(autoSchedule(state, 'a').directive ?? {}), /batch-verify/)
})

test('a batch of two writes asks for one covering check, and never says to skip it', () => {
  const state = createAutoState()
  notePolicy(state, 'a', { batchVerify: true })
  quietStart(state, 'a')
  noteTool(state, 'a', { name: 'write', argsKey: 'x.js', chars: 10 })
  noteTool(state, 'a', { name: 'write', argsKey: 'y.js', chars: 10 })
  noteStep(state, 'a')
  const directive = autoSchedule(state, 'a').directive
  assert.equal(directive?.kind, 'batch-verify')
  assert.match(directive.text, /still has to pass/i)
  assert.doesNotMatch(directive.text, /\bskip\b/i)
})

test('a successful check resets the batch, and one reminder per batch is enough', () => {
  const state = createAutoState()
  notePolicy(state, 'a', { batchVerify: true })
  quietStart(state, 'a')
  noteTool(state, 'a', { name: 'write', argsKey: 'x.js', chars: 10 })
  noteTool(state, 'a', { name: 'write', argsKey: 'y.js', chars: 10 })
  noteStep(state, 'a')
  assert.equal(autoSchedule(state, 'a').directive?.kind, 'batch-verify')

  noteStep(state, 'a')
  noteTool(state, 'a', { name: 'bash', argsKey: 'npm test', chars: 100, digest: 'green' })
  noteStep(state, 'a')
  noteTool(state, 'a', { name: 'read', argsKey: 'z.js', chars: 10 })
  assert.notEqual(autoSchedule(state, 'a').directive?.kind, 'batch-verify')
})

test('a single write is not a batch', () => {
  const state = createAutoState()
  notePolicy(state, 'a', { batchVerify: true })
  quietStart(state, 'a')
  noteTool(state, 'a', { name: 'write', argsKey: 'x.js', chars: 10 })
  noteStep(state, 'a')
  assert.notEqual(autoSchedule(state, 'a').directive?.kind, 'batch-verify')
})
