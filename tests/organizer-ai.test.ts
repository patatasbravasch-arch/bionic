import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { handleLorebookOrganizerMessage } from '../src/lorebook-organizer-backend'

const frontend = readFileSync(new URL('../src/lorebook-organizer-frontend.ts', import.meta.url), 'utf8')
function functionSource(name: string) {
  const start = frontend.search(new RegExp(`  (?:async )?function ${name}\\(`))
  if (start < 0) throw new Error(`Missing ${name}`)
  const after = frontend.slice(start + 1)
  const end = after.search(/\n  (?:async )?function |\n  \/\*\n    UI\/rendering/)
  return frontend.slice(start, start + 1 + end)
}

function harness() {
  let finish: (value: any) => void
  let fail: (error: Error) => void
  const generated = new Promise((resolve, reject) => { finish = resolve; fail = reject })
  const rendered: any[] = []
  const calls: any[] = []
  const timers = new Map<number, () => void>()
  let nextTimer = 0
  let context: any
  const api = {
    world_books: { async update() {} },
    sendToFrontend(payload: any, userId: string) {
      expect(userId).toBe('test-user')
      context.handleBackendMessage(payload)
    },
    generate: { quiet(input: any) { calls.push(input); return generated } },
  }
  context = vm.createContext({
    Math, Date, Map, Set, Error, JSON, Array,
    AI_BATCH_SIZE: 70,
    selectedConnectionId: () => 'chosen-connection',
    rebuildGroups() {},
    setTimeout(fn: () => void) { timers.set(++nextTimer, fn); return nextTimer },
    clearTimeout(id: number) { timers.delete(id) },
    renderAll(message: string) { rendered.push({ message, busy: context.state().busy, suggestions: context.state().suggestions }) },
    ctx: { sendToBackend(payload: any) { void handleLorebookOrganizerMessage(api, payload, 'test-user') } },
  })
  const extracted = ['requestId', 'sendBackend', 'handleBackendMessage', 'analyzeFolders', 'applyAssignments'].map(functionSource).join('\n')
  const compiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(extracted)
  vm.runInContext(`let pending = new Map(); let busy = false; let suggestions = []; let books = [
    { id: 'book-a', name: 'World lore A', entryCount: 1, entries: ['world'] },
    { id: 'book-b', name: 'World lore B', entryCount: 1, entries: ['world'] }
  ]; ${compiled}; function state() { return { busy, suggestions, pending: pending.size } }; function setBooks(value) { books = value }`, context)
  return { context, calls, rendered, timers, finish: finish!, fail: fail! }
}

test('AI progress keeps the request pending until real suggestions arrive', async () => {
  const h = harness()
  const analysis = h.context.analyzeFolders()
  await Promise.resolve()
  expect(h.context.state().busy).toBe(true)
  expect(h.context.state().pending).toBe(1)
  expect(h.timers.size).toBe(1)
  expect(h.calls[0].userId).toBe('test-user')
  expect(h.calls[0].connection_id).toBe('chosen-connection')
  h.finish({ content: JSON.stringify({ folders: [{ name: 'World', bookIds: ['book-a', 'book-b'], reason: 'Same setting' }] }) })
  await analysis
  expect(h.context.state().pending).toBe(0)
  expect(h.timers.size).toBe(0)
  expect(h.context.state().suggestions[0].bookIds).toEqual(['book-a', 'book-b'])
  expect(h.rendered.at(-1).busy).toBe(false)
  expect(h.rendered.at(-1).message).toContain('AI suggested 1 folder')
})

test('provider failure after progress is displayed and enables retry', async () => {
  const h = harness()
  const analysis = h.context.analyzeFolders()
  h.fail(new Error('Selected connection failed'))
  await analysis
  expect(h.context.state().busy).toBe(false)
  expect(h.context.state().pending).toBe(0)
  expect(h.rendered.at(-1)).toMatchObject({ busy: false, message: 'AI organize failed: Selected connection failed' })
})

test('malformed AI output surfaces its error instead of reporting empty suggestions', async () => {
  const h = harness()
  const analysis = h.context.analyzeFolders()
  h.finish({ content: 'No JSON here' })
  await analysis
  expect(h.rendered.at(-1).busy).toBe(false)
  expect(h.rendered.at(-1).message).toContain('did not return valid JSON')
})

test('unrelated replies do not consume a pending request', async () => {
  const h = harness()
  const analysis = h.context.analyzeFolders()
  expect(h.context.handleBackendMessage({ requestId: 'unrelated', type: 'bionic_lore_ai_result', folders: [] })).toBe(false)
  expect(h.context.state().pending).toBe(1)
  h.finish({ content: '{"folders":[]}' })
  await analysis
  expect(h.rendered.at(-1).message).toContain('no useful multi-book')
  expect(h.rendered.at(-1).busy).toBe(false)
})

test('timeout enables retry and ignores a late provider response', async () => {
  const h = harness()
  const analysis = h.context.analyzeFolders()
  for (const timeout of h.timers.values()) timeout()
  await analysis
  expect(h.rendered.at(-1).message).toContain('timed out')
  expect(h.rendered.at(-1).busy).toBe(false)
  h.finish({ content: '{"folders":[]}' })
  await Promise.resolve()
  expect(h.context.state().suggestions).toEqual([])
})

test('a library with 71 books avoids a final one-book request', async () => {
  const h = harness()
  h.context.setBooks(Array.from({ length: 71 }, (_, i) => ({ id: `book-${i}`, name: `Book ${i}` })))
  const analysis = h.context.analyzeFolders()
  h.finish({ content: '{"folders":[]}' })
  await analysis
  expect(h.calls.length).toBe(2)
  expect(h.rendered.at(-1).message).toContain('no useful multi-book')
  expect(h.rendered.at(-1).busy).toBe(false)
})

test('applying AI folders re-enables controls after completion', async () => {
  const h = harness()
  expect(await h.context.applyAssignments([{ bookId: 'book-a', folder: 'World' }])).toBe(true)
  expect(h.rendered.at(-1).busy).toBe(false)
  expect(h.rendered.at(-1).message).toContain('Applied 1 folder assignment')
})
