export function setup(ctx) {
  const MESSAGE_SELECTOR = '[data-component="MessageContent"]'
  const WORD_RE = /\p{L}[\p{L}\p{M}\p{N}'’\-]*/gu

  const SKIP_SELECTOR = [
    'code',
    'pre',
    'kbd',
    'samp',
    'button',
    'textarea',
    'input',
    'select',
    'option',
    'script',
    'style',
    'svg',
    'math',
    'strong',
    'b',
    '[data-lumiverse-html-island]',
    '[data-lumibionic-word]'
  ].join(',')

  const segmenter =
    typeof Intl.Segmenter === 'function'
      ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
      : null

  const removeStyle = ctx.dom.addStyle(`
    [data-lumibionic-fix] {
      font-weight: 700 !important;
    }
  `)

  function graphemes(value) {
    if (!segmenter) return Array.from(value)
    return Array.from(segmenter.segment(value), part => part.segment)
  }

  function processTextNode(node) {
    const parent = node.parentElement
    if (!parent) return

    if (parent.closest(SKIP_SELECTOR)) return

    const text = node.nodeValue || ''
    if (!/\p{L}/u.test(text)) return

    const doc = node.ownerDocument
    const fragment = doc.createDocumentFragment()

    let lastIndex = 0
    let changed = false

    for (const match of text.matchAll(WORD_RE)) {
      const word = match[0]
      const index = match.index ?? 0
      const chars = graphemes(word)

      if (chars.length < 2) continue

      if (index > lastIndex) {
        fragment.appendChild(
          doc.createTextNode(text.slice(lastIndex, index))
        )
      }

      const cut = Math.max(1, Math.ceil(chars.length * 0.5))

      const wordWrapper = doc.createElement('span')
      wordWrapper.setAttribute('data-lumibionic-word', '')

      const fixation = doc.createElement('span')
      fixation.setAttribute('data-lumibionic-fix', '')
      fixation.textContent = chars.slice(0, cut).join('')

      wordWrapper.appendChild(fixation)
      wordWrapper.appendChild(
        doc.createTextNode(chars.slice(cut).join(''))
      )

      fragment.appendChild(wordWrapper)

      lastIndex = index + word.length
      changed = true
    }

    if (!changed) return

    if (lastIndex < text.length) {
      fragment.appendChild(
        doc.createTextNode(text.slice(lastIndex))
      )
    }

    node.parentNode?.replaceChild(fragment, node)
  }

  function processMessage(root) {
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT
    )

    const nodes = []

    while (walker.nextNode()) {
      nodes.push(walker.currentNode)
    }

    for (const node of nodes) {
      processTextNode(node)
    }
  }

  function processAll() {
    document
      .querySelectorAll(MESSAGE_SELECTOR)
      .forEach(processMessage)
  }

  let scheduled = false

  function scheduleProcess() {
    if (scheduled) return

    scheduled = true

    requestAnimationFrame(() => {
      scheduled = false
      processAll()
    })
  }

  const observer = new MutationObserver(scheduleProcess)

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  })

  processAll()

  function unwrapAll() {
    document
      .querySelectorAll('[data-lumibionic-word]')
      .forEach(el => {
        el.replaceWith(
          document.createTextNode(el.textContent || '')
        )
      })
  }

  return () => {
    observer.disconnect()
    unwrapAll()
    removeStyle()
    ctx.dom.cleanup()
  }
}
