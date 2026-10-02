import { test, expect } from 'bun:test'
import { JSDOM } from 'jsdom'
import { createKenSleepCompanion, createKenSleepGate, kenSleepNight } from '../src/ken-sleep-companion'

test('Ken reminder only counts Ken user messages in the active chat at night', () => {
  let current = new Date('2026-10-02T23:30:00'), active = 'chat-a', dismissed: string | null = null, shown = 0
  const gate = createKenSleepGate({ activeChatId: () => active, now: () => current, dismissedNight: () => dismissed, show: () => shown++ })
  const message = (personaName = 'Ken', isUser = true, chatId = active) => gate.onMessage({ personaName, isUser, chatId })
  message('Other'); message('Ken', false); message('ken'); message('Ken', true, 'other-chat')
  expect(shown).toBe(0)
  message(); expect(shown).toBe(0)
  message(); expect(shown).toBe(1)
  for (let i = 0; i < 6; i++) message()
  expect(shown).toBe(1)
  current = new Date('2026-10-02T23:46:00')
  message(); expect(shown).toBe(2)
  dismissed = kenSleepNight(current)
  for (let i = 0; i < 10; i++) message()
  expect(shown).toBe(2)
  active = 'chat-b'; current = new Date('2026-10-03T10:00:00')
  message(); message(); expect(shown).toBe(2)
  dismissed = null; current = new Date('2026-10-03T22:30:00')
  message(); message(); expect(shown).toBe(3)
})

test('early morning uses the previous bedtime night', () => {
  expect(kenSleepNight(new Date('2026-10-03T02:00:00'))).toBe('2026-10-02')
  expect(kenSleepNight(new Date('2026-10-03T21:59:00'))).toBeNull()
  expect(kenSleepNight(new Date('2026-10-03T22:00:00'))).toBe('2026-10-03')
})

test('bunny appears by the chat input, pets a pug sometimes, and dismisses cleanly', () => {
  const dom = new JSDOM('<div data-component="InputArea"></div>', { pretendToBeVisual: true })
  Object.defineProperty(dom.window, 'innerWidth', { value: 1000, configurable: true })
  Object.defineProperty(dom.window, 'innerHeight', { value: 800, configurable: true })
  const composer = dom.window.document.querySelector('[data-component="InputArea"]')!
  composer.getBoundingClientRect = () => ({ left: 100, right: 900, top: 700, bottom: 780, width: 800, height: 80, x: 100, y: 700, toJSON() {} })
  let dismissed = 0, randomCalls = 0
  const companion = createKenSleepCompanion(dom.window.document, { onDismiss: () => dismissed++, random: () => randomCalls++ ? 0.1 : 0 })
  try {
    companion.show()
    const bunny = dom.window.document.querySelector('.ken-bedtime') as HTMLElement
    expect(bunny).not.toBeNull()
    expect(bunny.style.left).toBe('112px')
    expect(bunny.style.bottom).toBe('81px')
    expect(bunny.querySelector('.ken-bunny')!.getAttribute('aria-label')).toBe('Sleepy bunny lying on the chat textbox')
    expect(bunny.querySelector('.ken-bunny')).not.toBeNull()
    expect(bunny.querySelector('.ken-pug')).not.toBeNull()
    expect(bunny.classList.contains('ken-bedtime-with-pug')).toBe(true)
    expect(bunny.textContent).toContain("I'm sleepy. You should go to bed too.")
    companion.show()
    expect(dom.window.document.querySelectorAll('.ken-bedtime')).toHaveLength(1)
    ;(bunny.querySelector('.ken-bedtime-close') as HTMLButtonElement).click()
    expect(dismissed).toBe(1)
    expect(companion.isVisible()).toBe(false)
    companion.show(true)
    ;(dom.window.document.querySelector('.ken-bedtime-close') as HTMLButtonElement).click()
    expect(dismissed).toBe(1)
    const melatonin = createKenSleepCompanion(dom.window.document, { onDismiss: () => {}, random: () => 0.25 })
    melatonin.show()
    expect(dom.window.document.querySelector('.ken-bedtime-line')!.textContent).toBe('Maybe you should take melatonin.')
    melatonin.destroy()
  } finally { companion.destroy(); dom.window.close() }
})
