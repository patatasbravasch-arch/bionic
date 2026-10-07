import { test, expect } from 'bun:test'
import { JSDOM } from 'jsdom'
import { bedtimeNight, createBedtimeCompanion, createBedtimeGate, validClockTime } from '../src/bedtime-reminder'

test('bedtime reminder follows the chosen time once per night, without a persona or message', () => {
  let current = new Date('2026-10-02T21:59:00'), enabled = false, open = false
  let shownNight: string | null = null, shown = 0
  const gate = createBedtimeGate({
    now: () => current,
    config: () => ({ enabled, bedtime: '22:00', wakeTime: '06:00' }),
    hasOpenChat: () => open,
    shownNight: () => shownNight,
    show: () => { shown++; shownNight = bedtimeNight(current, '22:00', '06:00') },
  })
  gate.check(); expect(shown).toBe(0)
  enabled = true; open = true
  gate.check(); expect(shown).toBe(0)
  current = new Date('2026-10-02T22:00:00')
  gate.check(); gate.check(); expect(shown).toBe(1)
  current = new Date('2026-10-03T02:00:00')
  gate.check(); expect(shown).toBe(1)
  current = new Date('2026-10-03T06:00:00')
  gate.check(); expect(shown).toBe(1)
  current = new Date('2026-10-03T22:10:00')
  open = false; gate.check(); expect(shown).toBe(1)
  open = true; gate.check(); expect(shown).toBe(2)
})

test('custom times and early morning map to the intended night', () => {
  expect(bedtimeNight(new Date('2026-10-03T02:00:00'), '22:00', '06:00')).toBe('2026-10-02')
  expect(bedtimeNight(new Date('2026-10-03T21:59:00'), '22:00', '06:00')).toBeNull()
  expect(bedtimeNight(new Date('2026-10-03T22:00:00'), '22:00', '06:00')).toBe('2026-10-03')
  expect(bedtimeNight(new Date('2026-10-03T01:15:00'), '01:15', '08:00')).toBe('2026-10-03')
  expect(bedtimeNight(new Date('2026-10-03T08:00:00'), '01:15', '08:00')).toBeNull()
  expect(bedtimeNight(new Date('2026-10-03T22:00:00'), '22:00', '22:00')).toBeNull()
  expect(validClockTime('25:00')).toBe(false)
})

test('bunny appears by the chat input, pets a pug sometimes, and dismisses cleanly', () => {
  const dom = new JSDOM('<div data-component="InputArea"></div>', { pretendToBeVisual: true })
  Object.defineProperty(dom.window, 'innerWidth', { value: 1000, configurable: true })
  Object.defineProperty(dom.window, 'innerHeight', { value: 800, configurable: true })
  const composer = dom.window.document.querySelector('[data-component="InputArea"]')!
  composer.getBoundingClientRect = () => ({ left: 100, right: 900, top: 700, bottom: 780, width: 800, height: 80, x: 100, y: 700, toJSON() {} })
  let dismissed = 0, randomCalls = 0
  const companion = createBedtimeCompanion(dom.window.document, { onDismiss: () => dismissed++, random: () => randomCalls++ ? 0.1 : 0 })
  try {
    companion.show()
    const bunny = dom.window.document.querySelector('.ken-bedtime') as HTMLElement
    expect(bunny).not.toBeNull()
    expect(bunny.style.left).toBe('112px')
    expect(bunny.style.bottom).toBe('81px')
    expect(bunny.querySelector('.ken-duo')!.getAttribute('alt')).toBe("Bunny resting one paw on the sleepy pug's head")
    expect(bunny.querySelector('.ken-bunny')).toBeNull()
    expect(bunny.querySelector('.ken-pug')).toBeNull()
    expect(bunny.querySelector('.ken-petting-paw')).toBeNull()
    expect(bunny.classList.contains('ken-bedtime-with-pug')).toBe(true)
    expect(bunny.querySelector('.ken-bedtime-line')!.textContent!.length).toBeGreaterThan(0)
    companion.show()
    expect(dom.window.document.querySelectorAll('.ken-bedtime')).toHaveLength(1)
    ;(bunny.querySelector('.ken-bedtime-close') as HTMLButtonElement).click()
    expect(dismissed).toBe(1)
    expect(companion.isVisible()).toBe(false)
    companion.show(true)
    ;(dom.window.document.querySelector('.ken-bedtime-close') as HTMLButtonElement).click()
    expect(dismissed).toBe(1)
    const solo = createBedtimeCompanion(dom.window.document, { onDismiss: () => {}, random: () => 0.5 })
    const seen = new Set<string>()
    for (let i = 0; i < 20; i++) {
      solo.show()
      seen.add(dom.window.document.querySelector('.ken-bedtime-line')!.textContent!)
      expect(dom.window.document.querySelector('.ken-bunny')!.getAttribute('alt')).toBe('Sleepy bunny lying on the chat textbox')
      expect(dom.window.document.querySelector('.ken-duo')).toBeNull()
      solo.hide()
    }
    expect(seen.size).toBe(20)
    solo.destroy()
  } finally { companion.destroy(); dom.window.close() }
})
