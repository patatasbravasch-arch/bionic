export function setup(ctx) {
  const MESSAGE_SELECTOR = '[data-component="MessageContent"]'
  const SETTINGS_KEY = 'lumiverse:bionic-style-reading:v0.4'
  const WORD_RE = /\p{L}[\p{L}\p{M}\p{N}'’\-]*/gu

  const DEFAULTS = {
    enabled: true,
    density: 'balanced',
    fixation: 35,
    weight: 600,
    font: 'inherit',
    textSize: 100,
    lineHeight: 1.55,
  }

  const FONT_OPTIONS = [
    ['inherit', 'Lumiverse default'],
    ['system-ui, sans-serif', 'System Sans'],
    ['Arial, sans-serif', 'Arial'],
    ['Verdana, sans-serif', 'Verdana'],
    ['Tahoma, sans-serif', 'Tahoma'],
    ['"Trebuchet MS", sans-serif', 'Trebuchet MS'],
    ['Georgia, serif', 'Georgia'],
    ['"Times New Roman", serif', 'Times New Roman'],
  ]

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
    '[contenteditable="true"]',
    '[data-lumiverse-html-island]',
    '[data-lumibionic-word]',
  ].join(',')

  function clamp(value, min, max, fallback) {
    const n = Number(value)
    return Number.isFinite(n)
      ? Math.min(max, Math.max(min, n))
      : fallback
  }

  function loadSettings() {
    try {
      const saved = JSON.parse(
        localStorage.getItem(SETTINGS_KEY) || '{}'
      )

      return {
        enabled:
          typeof saved.enabled === 'boolean'
            ? saved.enabled
            : DEFAULTS.enabled,

        density:
          ['light', 'balanced', 'full'].includes(saved.density)
            ? saved.density
            : DEFAULTS.density,

        fixation: clamp(
          saved.fixation,
          20,
          70,
          DEFAULTS.fixation
        ),

        weight: clamp(
          saved.weight,
          500,
          900,
          DEFAULTS.weight
        ),

        font:
          typeof saved.font === 'string'
            ? saved.font
            : DEFAULTS.font,

        textSize: clamp(
          saved.textSize,
          80,
          140,
          DEFAULTS.textSize
        ),

        lineHeight: clamp(
          saved.lineHeight,
          1.1,
          2.2,
          DEFAULTS.lineHeight
        ),
      }
    } catch {
      return { ...DEFAULTS }
    }
  }

  let settings = loadSettings()
  let scheduled = false
  let rebuilding = false

  const segmenter =
    typeof Intl.Segmenter === 'function'
      ? new Intl.Segmenter(undefined, {
          granularity: 'grapheme',
        })
      : null

  function graphemes(value) {
    if (!segmenter) return Array.from(value)

    return Array.from(
      segmenter.segment(value),
      part => part.segment
    )
  }

  function shouldEmphasize(length) {
    if (settings.density === 'light') {
      return length >= 6
    }

    if (settings.density === 'balanced') {
      return length >= 4
    }

    return length >= 2
  }

  function fixationCut(word) {
    const chars = graphemes(word)
    const length = chars.length

    if (!shouldEmphasize(length)) {
      return { chars, cut: 0 }
    }

    let base

    if (length <= 5) {
      base = 1
    } else if (length <= 8) {
      base = 2
    } else if (length <= 11) {
      base = 3
    } else {
      base = 4
    }

    const multiplier =
      settings.fixation / 35

    let cut =
      Math.round(base * multiplier)

    cut = Math.max(
      1,
      Math.min(
        cut,
        4,
        length - 1
      )
    )

    return { chars, cut }
  }

  const removeStyle = ctx.dom.addStyle(`
    [data-component="MessageContent"].lumibionic-message {
      font-family:
        var(--lumibionic-font-family, inherit)
        !important;

      font-size:
        var(--lumibionic-text-size, 100%)
        !important;

      line-height:
        var(--lumibionic-line-height, 1.55)
        !important;
    }

    [data-lumibionic-fix] {
      font-weight:
        var(--lumibionic-weight, 600)
        !important;
    }

    .lumibionic-settings {
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 18px;
    }

    .lumibionic-settings h2 {
      margin: 0;
      font-size: 17px;
    }

    .lumibionic-muted {
      opacity: 0.68;
      font-size: 12px;
      line-height: 1.45;
    }

    .lumibionic-control {
      display: flex;
      flex-direction: column;
      gap: 7px;
    }

    .lumibionic-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .lumibionic-control label {
      font-size: 13px;
      font-weight: 600;
    }

    .lumibionic-value {
      min-width: 48px;
      text-align: right;
      opacity: 0.7;
      font-size: 12px;
    }

    .lumibionic-settings input[type="range"],
    .lumibionic-settings select,
    .lumibionic-settings button {
      width: 100%;
      box-sizing: border-box;
    }

    .lumibionic-settings select,
    .lumibionic-settings button {
      padding: 9px 10px;
      border-radius: 8px;
      font: inherit;
    }

    .lumibionic-settings button {
      cursor: pointer;
    }

    .lumibionic-preview {
      padding: 14px;
      border-radius: 8px;
      background: rgba(127,127,127,0.08);

      font-family:
        var(--lumibionic-font-family, inherit);

      font-size:
        var(--lumibionic-text-size, 100%);

      line-height:
        var(--lumibionic-line-height, 1.55);
    }
  `)

  const tab = ctx.ui.registerDrawerTab({
    id: 'bionic-reading',
    title: 'Bionic Reading',
    shortName: 'Bionic',
    headerTitle: 'Bionic Reading',

    description:
      'Customize reading emphasis and typography',

    keywords: [
      'bionic',
      'reading',
      'font',
      'accessibility',
    ],
  })

  function processTextNode(node) {
    const parent = node.parentElement
    if (!parent) return

    if (parent.closest(SKIP_SELECTOR)) {
      return
    }

    const text = node.nodeValue || ''

    if (!/\p{L}/u.test(text)) {
      return
    }

    const doc = node.ownerDocument
    const fragment =
      doc.createDocumentFragment()

    let lastIndex = 0
    let changed = false

    for (const match of text.matchAll(WORD_RE)) {
      const word = match[0]
      const index = match.index ?? 0

      const { chars, cut } =
        fixationCut(word)

      if (!cut) continue

      if (index > lastIndex) {
        fragment.appendChild(
          doc.createTextNode(
            text.slice(lastIndex, index)
          )
        )
      }

      const wrapper =
        doc.createElement('span')

      wrapper.setAttribute(
        'data-lumibionic-word',
        ''
      )

      const fix =
        doc.createElement('span')

      fix.setAttribute(
        'data-lumibionic-fix',
        ''
      )

      fix.textContent =
        chars.slice(0, cut).join('')

      wrapper.appendChild(fix)

      wrapper.appendChild(
        doc.createTextNode(
          chars.slice(cut).join('')
        )
      )

      fragment.appendChild(wrapper)

      lastIndex =
        index + word.length

      changed = true
    }

    if (!changed) return

    if (lastIndex < text.length) {
      fragment.appendChild(
        doc.createTextNode(
          text.slice(lastIndex)
        )
      )
    }

    node.parentNode?.replaceChild(
      fragment,
      node
    )
  }

  function processMessage(root) {
    if (!settings.enabled) return

    root.classList.add(
      'lumibionic-message'
    )

    const walker =
      document.createTreeWalker(
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

  function unwrap(root = document) {
    root
      .querySelectorAll(
        '[data-lumibionic-word]'
      )
      .forEach(el => {
        el.replaceWith(
          document.createTextNode(
            el.textContent || ''
          )
        )
      })

    root
      .querySelectorAll(
        `${MESSAGE_SELECTOR}.lumibionic-message`
      )
      .forEach(el => {
        el.classList.remove(
          'lumibionic-message'
        )

        el.normalize()
      })
  }

  function processAll() {
    if (
      rebuilding ||
      !settings.enabled
    ) return

    document
      .querySelectorAll(
        MESSAGE_SELECTOR
      )
      .forEach(processMessage)
  }

  function rebuildAll() {
    rebuilding = true
    unwrap()
    rebuilding = false

    if (settings.enabled) {
      processAll()
    }
  }

  function scheduleProcess() {
    if (
      scheduled ||
      rebuilding ||
      !settings.enabled
    ) return

    scheduled = true

    requestAnimationFrame(() => {
      scheduled = false
      processAll()
    })
  }

  function applyCssSettings() {
    const root =
      document.documentElement

    root.style.setProperty(
      '--lumibionic-weight',
      String(settings.weight)
    )

    root.style.setProperty(
      '--lumibionic-font-family',
      settings.font
    )

    root.style.setProperty(
      '--lumibionic-text-size',
      `${settings.textSize}%`
    )

    root.style.setProperty(
      '--lumibionic-line-height',
      String(settings.lineHeight)
    )
  }

  function saveSettings() {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify(settings)
    )
  }

  function updateSetting(
    key,
    value,
    rebuild = false
  ) {
    settings = {
      ...settings,
      [key]: value,
    }

    saveSettings()
    applyCssSettings()
    syncControls()

    if (
      rebuild ||
      key === 'enabled'
    ) {
      rebuildAll()
    }

    renderPreview()
  }

  tab.root.innerHTML = `
    <div class="lumibionic-settings">

      <div>
        <h2>Bionic Reading</h2>
        <div class="lumibionic-muted">
          A gentler emphasis mode designed
          for smoother long-form reading.
        </div>
      </div>

      <div class="lumibionic-row">
        <strong>Enabled</strong>
        <input
          id="lb-enabled"
          type="checkbox"
        >
      </div>

      <div class="lumibionic-control">
        <label>Emphasis density</label>

        <select id="lb-density">
          <option value="light">
            Light — longer words only
          </option>

          <option value="balanced">
            Balanced — recommended
          </option>

          <option value="full">
            Full — classic effect
          </option>
        </select>
      </div>

      <div class="lumibionic-control">
        <div class="lumibionic-row">
          <label>Fixation strength</label>
          <span
            class="lumibionic-value"
            id="lb-fixation-value"
          ></span>
        </div>

        <input
          id="lb-fixation"
          type="range"
          min="20"
          max="70"
          step="5"
        >

        <div class="lumibionic-muted">
          Controls how much of longer words
          receives emphasis.
        </div>
      </div>

      <div class="lumibionic-control">
        <div class="lumibionic-row">
          <label>Bold weight</label>
          <span
            class="lumibionic-value"
            id="lb-weight-value"
          ></span>
        </div>

        <input
          id="lb-weight"
          type="range"
          min="500"
          max="900"
          step="100"
        >
      </div>

      <div class="lumibionic-control">
        <label>Font</label>
        <select id="lb-font"></select>
      </div>

      <div class="lumibionic-control">
        <div class="lumibionic-row">
          <label>Text size</label>
          <span
            class="lumibionic-value"
            id="lb-size-value"
          ></span>
        </div>

        <input
          id="lb-size"
          type="range"
          min="80"
          max="140"
          step="5"
        >
      </div>

      <div class="lumibionic-control">
        <div class="lumibionic-row">
          <label>Line spacing</label>
          <span
            class="lumibionic-value"
            id="lb-line-value"
          ></span>
        </div>

        <input
          id="lb-line"
          type="range"
          min="1.1"
          max="2.2"
          step="0.05"
        >
      </div>

      <div class="lumibionic-control">
        <label>Preview</label>

        <div
          class="lumibionic-preview"
          id="lb-preview"
        ></div>
      </div>

      <button
        type="button"
        id="lb-reset"
      >
        Reset defaults
      </button>

    </div>
  `

  const $ = selector =>
    tab.root.querySelector(selector)

  const enabled = $('#lb-enabled')
  const density = $('#lb-density')
  const fixation = $('#lb-fixation')
  const fixationValue =
    $('#lb-fixation-value')
  const weight = $('#lb-weight')
  const weightValue =
    $('#lb-weight-value')
  const font = $('#lb-font')
  const size = $('#lb-size')
  const sizeValue =
    $('#lb-size-value')
  const line = $('#lb-line')
  const lineValue =
    $('#lb-line-value')
  const preview = $('#lb-preview')
  const reset = $('#lb-reset')

  for (
    const [value, label]
    of FONT_OPTIONS
  ) {
    const option =
      document.createElement('option')

    option.value = value
    option.textContent = label

    font.appendChild(option)
  }

  function syncControls() {
    enabled.checked = settings.enabled
    density.value = settings.density

    fixation.value =
      String(settings.fixation)

    fixationValue.textContent =
      `${settings.fixation}%`

    weight.value =
      String(settings.weight)

    weightValue.textContent =
      String(settings.weight)

    font.value = settings.font

    size.value =
      String(settings.textSize)

    sizeValue.textContent =
      `${settings.textSize}%`

    line.value =
      String(settings.lineHeight)

    lineValue.textContent =
      settings.lineHeight.toFixed(2)
  }

  function renderPreview() {
    preview.replaceChildren()

    const sample =
      document.createTextNode(
        'A dry mocking chuckle shook his chest as he leaned closer toward the doorway.'
      )

    preview.appendChild(sample)

    if (settings.enabled) {
      processTextNode(sample)
    }
  }

  enabled.addEventListener(
    'change',
    () => {
      updateSetting(
        'enabled',
        enabled.checked,
        true
      )
    }
  )

  density.addEventListener(
    'change',
    () => {
      updateSetting(
        'density',
        density.value,
        true
      )
    }
  )

  fixation.addEventListener(
    'input',
    () => {
      updateSetting(
        'fixation',
        Number(fixation.value),
        true
      )
    }
  )

  weight.addEventListener(
    'input',
    () => {
      updateSetting(
        'weight',
        Number(weight.value)
      )
    }
  )

  font.addEventListener(
    'change',
    () => {
      updateSetting(
        'font',
        font.value
      )
    }
  )

  size.addEventListener(
    'input',
    () => {
      updateSetting(
        'textSize',
        Number(size.value)
      )
    }
  )

  line.addEventListener(
    'input',
    () => {
      updateSetting(
        'lineHeight',
        Number(line.value)
      )
    }
  )

  reset.addEventListener(
    'click',
    () => {
      settings = { ...DEFAULTS }

      saveSettings()
      applyCssSettings()
      syncControls()
      rebuildAll()
      renderPreview()
    }
  )

  const observer =
    new MutationObserver(
      scheduleProcess
    )

  observer.observe(
    document.body,
    {
      childList: true,
      subtree: true,
      characterData: true,
    }
  )

  applyCssSettings()
  syncControls()
  renderPreview()
  processAll()

  return () => {
    observer.disconnect()
    unwrap()
    tab.destroy()
    removeStyle()
    ctx.dom.cleanup()

    const root =
      document.documentElement

    root.style.removeProperty(
      '--lumibionic-weight'
    )

    root.style.removeProperty(
      '--lumibionic-font-family'
    )

    root.style.removeProperty(
      '--lumibionic-text-size'
    )

    root.style.removeProperty(
      '--lumibionic-line-height'
    )
  }
}
