type InlineFont = { value: string; priority: string }

const originalFonts = new WeakMap<HTMLElement, InlineFont>()

/** Changing the typeface must preserve authored sizes and heading hierarchy. */
export function overrideFontFamily(element: HTMLElement, font: string): void {
  if (!originalFonts.has(element)) {
    originalFonts.set(element, {
      value: element.style.getPropertyValue('font-family'),
      priority: element.style.getPropertyPriority('font-family'),
    })
  }
  element.style.setProperty('font-family', font, 'important')
}

export function restoreFontFamily(element: HTMLElement): void {
  const original = originalFonts.get(element)
  if (!original) return

  if (original.value) {
    element.style.setProperty('font-family', original.value, original.priority)
  } else {
    element.style.removeProperty('font-family')
  }
  originalFonts.delete(element)
}
