import { test, expect } from 'bun:test'
import { JSDOM } from 'jsdom'
import { overrideFontFamily, restoreFontFamily } from '../src/font-override'

test('font override preserves authored text sizes, line heights and heading sizes', () => {
  const dom = new JSDOM('<p style="font-size:10px!important;line-height:1.4;font-family:serif!important">Small text</p><h3 style="font-size:24px">Heading</h3>')
  const elements = [...dom.window.document.querySelectorAll<HTMLElement>('p,h3')]
  for (const element of elements) {
    const size = element.style.getPropertyValue('font-size')
    const priority = element.style.getPropertyPriority('font-size')
    const lineHeight = element.style.lineHeight
    const original = element.style.cssText
    overrideFontFamily(element, 'Arial, sans-serif')
    overrideFontFamily(element, 'Georgia, serif')
    expect(element.style.getPropertyValue('font-size')).toBe(size)
    expect(element.style.getPropertyPriority('font-size')).toBe(priority)
    expect(element.style.lineHeight).toBe(lineHeight)
    restoreFontFamily(element)
    expect(element.style.cssText).toBe(original)
  }
})

test('restores inherited families and leaves styles alone when already restored', () => {
  const dom = new JSDOM('<p style="font-size:12px">Text</p>')
  const element = dom.window.document.querySelector('p')!
  overrideFontFamily(element, 'Arial')
  restoreFontFamily(element)
  expect(element.style.getPropertyValue('font-family')).toBe('')
  element.style.fontFamily = 'serif'
  restoreFontFamily(element)
  expect(element.style.fontFamily).toBe('serif')
  expect(element.style.fontSize).toBe('12px')
})

test('preserves HTML island typography across shadow-root font changes', () => {
  const dom = new JSDOM('<div></div>')
  const shadow = dom.window.document.querySelector('div')!.attachShadow({ mode: 'open' })
  shadow.innerHTML = '<p style="font-size:11px;font-family:serif">Island</p>'
  const element = shadow.querySelector('p')!
  overrideFontFamily(element, 'Arial')
  expect(element.style.fontSize).toBe('11px')
  restoreFontFamily(element)
  expect(element.style.fontSize).toBe('11px')
  expect(element.style.fontFamily).toBe('serif')
})
