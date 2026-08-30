export function setup(ctx) {
  const MESSAGE_SELECTOR = '[data-component="MessageContent"]'
  const SETTINGS_KEY = 'lumiverse:bionic-style-reading:v0.3'
  const WORD_RE = /\p{L}[\p{L}\p{M}\p{N}'’\-]*/gu

  const DEFAULTS = {
    enabled: true,
    fixation: 50,
    weight: 700,
    font: 'inherit',
    textSize: 100,
    lineHeight: 1.5,
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
    ['ui-monospace, monospace', 'Monospace'],
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

  function clampNumber(value, min, max, fallback) {
    const number = Number(value)
    if (!Number.isFinite(number)) return fallback
    return Math.min(max, Math.max(min, number))
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

        fixation: clampNumber(
          saved.fixation,
          20,
          80,
          DEFAULTS.fixation
        ),

        weight: clampNumber(
          saved.weight,
          500,
          900,
          DEFAULTS.weight
        ),

        font:
          typeof saved.font === 'string'
            ? saved.font
            : DEFAULTS.font,

        textSize: clampNumber(
          saved.textSize,
          80,
          140,
          DEFAULTS.textSize
        ),

        lineHeight: clampNumber(
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

  const removeStyle = ctx.dom.addStyle(`
    [data-component="MessageContent"].lumibionic-message {
      font-family:
        var(--lumibionic-font-family, inherit)
        !important;

      font-size:
        var(--lumibionic-text-size, 100%)
        !important;

      line-height:
        var(--lumibionic-line-height, 1.5)
        !important;
    }

    [data-lumibionic-fix] {
      font-weight:
        var(--lumibionic-weight, 700)
        !important;
    }

    .lumibionic-settings {
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 18px;
      color: var(--lumiverse-text);
    }

    .lumibionic-settings h2 {
      margin: 0;
      font-size: 17px;
    }

    .lumibionic-muted {
      color: var(--lumiverse-text-muted);
      font-size: 12px;
      line-height: 1.45;
    }

    .lumibionic-control {
      display: flex;
      flex-direction: column;
      gap: 7px;
    }

    .lumibionic-control-row {
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
      min-width: 52px;
      text-align: right;
      color: var(--lumiverse-text-muted);
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }

    .lumibionic-settings input[type="range"] {
      width: 100%;
    }

    .lumibionic-settings select,
    .lumibionic-settings button {
      width: 100%;
      box-sizing: border-box;
      padding: 9px 10px;

      border:
        1px solid var(--lumiverse-border);

      border-radius:
        var(--lumiverse-radius);

      background:
        var(--lumiverse-fill);

      color:
        var(--lumiverse-text);

      font: inherit;
    }

    .lumibionic-settings button {
      cursor: pointer;
    }

    .lumibionic-switch-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 0;
    }

    .lumibionic-preview {
      padding: 14px;

      border:
        1px solid var(--lumiverse-border);

      border-radius:
        var(--lumiverse-radius);

      background:
        var(--lumiverse-fill-subtle);

      font-family:
        var(--lumibionic-font-family, inherit);

      font-size:
        var(--lumibionic-text-size, 100%);

      line-height:
        var(--lumibionic-line-height, 1.5);
    }

    .lumibionic-preview [data-lumibionic-fix] {
      font-weight:
        var(--lumibionic-weight, 700)
        !important;
    }
  `)

  const tab = ctx.ui.registerDrawerTab({
    id: 'bionic-reading',

    title: 'Bionic Reading',

    shortName: 'Bionic',

    headerTitle: 'Bionic Reading',

    description:
      'Customize fixation, font, weight, size, and spacing',

    keywords: [
      'bionic',
      'reading',
      'font',
      'accessibility',
      'fixation',
    ],

    iconSvg: `
      <svg
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M4 5h9a4 4 0 0 1 0 8H4V5Z"
          stroke="currentColor"
          stroke-width="2"
        />
        <path
          d="M4 13h10a3 3 0 0 1 0 6H4v-6Z"
          stroke="currentColor"
          stroke-width="2"
        />
      </svg>
    `,
  })

  function graphemes(value) {
    if (!segmenter) return Array.from(value)

    return Array.from(
      segmenter.segment(value),
      part => part.segment
    )
  }

  function fixationCut(word) {
    const chars = graphemes(word)

    if (chars.length < 2) {
      return {
        chars,
        cut: 0,
      }
    }

    const cut = Math.max(
      1,
      Math.min(
        chars.length - 1,
        Math.ceil(
          chars.length *
          settings.fixation /
          100
        )
      )
    )

    return {
      chars,
      cut,
    }
  }

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

      const {
        chars,
        cut,
      } = fixationCut(word)

      if (!cut) continue

      if (index > lastIndex) {
        fragment.appendChild(
          doc.createTextNode(
            text.slice(
              lastIndex,
              index
            )
          )
        )
      }

      const wordWrapper =
        doc.createElement('span')

      wordWrapper.setAttribute(
        'data-lumibionic-word',
        ''
      )

      const fixation =
        doc.createElement('span')

      fixation.setAttribute(
        'data-lumibionic-fix',
        ''
      )

      fixation.textContent =
        chars
          .slice(0, cut)
          .join('')

      wordWrapper.appendChild(
        fixation
      )

      wordWrapper.appendChild(
        doc.createTextNode(
          chars
            .slice(cut)
            .join('')
        )
      )

      fragment.appendChild(
        wordWrapper
      )

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
      nodes.push(
        walker.currentNode
      )
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
      !settings.enabled ||
      rebuilding
    ) {
      return
    }

    document
      .querySelectorAll(
        MESSAGE_SELECTOR
      )
      .forEach(
        processMessage
      )
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
    ) {
      return
    }

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
    try {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify(settings)
      )
    } catch {
      // Settings still work for this session.
    }
  }

  function setSetting(
    key,
    value,
    needsRebuild = false
  ) {
    settings = {
      ...settings,
      [key]: value,
    }

    saveSettings()
    applyCssSettings()
    syncControls()

    if (
      key === 'enabled' ||
      needsRebuild
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
          Tune the fixation effect to whatever
          feels easiest to scan.
        </div>
      </div>

      <div class="lumibionic-switch-row">
        <label for="lumibionic-enabled">
          <strong>Enabled</strong>
        </label>

        <input
          id="lumibionic-enabled"
          type="checkbox"
        />
      </div>

      <div class="lumibionic-control">

        <div class="lumibionic-control-row">
          <label for="lumibionic-fixation">
            Fixation
          </label>

          <span
            class="lumibionic-value"
            id="lumibionic-fixation-value"
          ></span>
        </div>

        <input
          id="lumibionic-fixation"
          type="range"
          min="20"
          max="80"
          step="5"
        />

        <div class="lumibionic-muted">
          Percentage of each word emphasized.
        </div>

      </div>

      <div class="lumibionic-control">

        <div class="lumibionic-control-row">
          <label for="lumibionic-weight">
            Bold weight
          </label>

          <span
            class="lumibionic-value"
            id="lumibionic-weight-value"
          ></span>
        </div>

        <input
          id="lumibionic-weight"
          type="range"
          min="500"
          max="900"
          step="100"
        />

      </div>

      <div class="lumibionic-control">

        <label for="lumibionic-font">
          Font
        </label>

        <select
          id="lumibionic-font"
        ></select>

      </div>

      <div class="lumibionic-control">

        <div class="lumibionic-control-row">

          <label for="lumibionic-size">
            Text size
          </label>

          <span
            class="lumibionic-value"
            id="lumibionic-size-value"
          ></span>

        </div>

        <input
          id="lumibionic-size"
          type="range"
          min="80"
          max="140"
          step="5"
        />

      </div>

      <div class="lumibionic-control">

        <div class="lumibionic-control-row">

          <label for="lumibionic-line-height">
            Line spacing
          </label>

          <span
            class="lumibionic-value"
            id="lumibionic-line-height-value"
          ></span>

        </div>

        <input
          id="lumibionic-line-height"
          type="range"
          min="1.1"
          max="2.2"
          step="0.1"
        />

      </div>

      <div class="lumibionic-control">

        <label>
          Preview
        </label>

        <div
          class="lumibionic-preview"
          id="lumibionic-preview"
        ></div>

      </div>

      <button
        type="button"
        id="lumibionic-reset"
      >
        Reset defaults
      </button>

    </div>
  `

  const enabledInput =
    tab.root.querySelector(
      '#lumibionic-enabled'
    )

  const fixationInput =
    tab.root.querySelector(
      '#lumibionic-fixation'
    )

  const fixationValue =
    tab.root.querySelector(
      '#lumibionic-fixation-value'
    )

  const weightInput =
    tab.root.querySelector(
      '#lumibionic-weight'
    )

  const weightValue =
    tab.root.querySelector(
      '#lumibionic-weight-value'
    )

  const fontSelect =
    tab.root.querySelector(
      '#lumibionic-font'
    )

  const sizeInput =
    tab.root.querySelector(
      '#lumibionic-size'
    )

  const sizeValue =
    tab.root.querySelector(
      '#lumibionic-size-value'
    )

  const lineHeightInput =
    tab.root.querySelector(
      '#lumibionic-line-height'
    )

  const lineHeightValue =
    tab.root.querySelector(
      '#lumibionic-line-height-value'
    )

  const preview =
    tab.root.querySelector(
      '#lumibionic-preview'
    )

  const resetButton =
    tab.root.querySelector(
      '#lumibionic-reset'
    )

  for (
    const [value, label]
    of FONT_OPTIONS
  ) {
    const option =
      document.createElement(
        'option'
      )

    option.value = value
    option.textContent = label

    fontSelect?.appendChild(
      option
    )
  }

  function syncControls() {
    if (enabledInput) {
      enabledInput.checked =
        settings.enabled
    }

    if (fixationInput) {
      fixationInput.value =
        String(settings.fixation)
    }

    if (fixationValue) {
      fixationValue.textContent =
        `${settings.fixation}%`
    }

    if (weightInput) {
      weightInput.value =
        String(settings.weight)
    }

    if (weightValue) {
      weightValue.textContent =
        String(settings.weight)
    }

    if (fontSelect) {
      fontSelect.value =
        settings.font
    }

    if (sizeInput) {
      sizeInput.value =
        String(settings.textSize)
    }

    if (sizeValue) {
      sizeValue.textContent =
        `${settings.textSize}%`
    }

    if (lineHeightInput) {
      lineHeightInput.value =
        String(settings.lineHeight)
    }

    if (lineHeightValue) {
      lineHeightValue.textContent =
        settings.lineHeight.toFixed(1)
    }
  }

  function renderPreview() {
    if (!preview) return

    preview.replaceChildren()

    const textNode =
      document.createTextNode(
        'The quick brown fox jumps over the lazy dog.'
      )

    preview.appendChild(
      textNode
    )

    if (settings.enabled) {
      processTextNode(
        textNode
      )
    }
  }

  enabledInput?.addEventListener(
    'change',
    () => {
      setSetting(
        'enabled',
        enabledInput.checked
      )
    }
  )

  fixationInput?.addEventListener(
    'input',
    () => {
      setSetting(
        'fixation',
        Number(
          fixationInput.value
        ),
        true
      )
    }
  )

  weightInput?.addEventListener(
    'input',
    () => {
      setSetting(
        'weight',
        Number(
          weightInput.value
        )
      )
    }
  )

  fontSelect?.addEventListener(
    'change',
    () => {
      setSetting(
        'font',
        fontSelect.value
      )
    }
  )

  sizeInput?.addEventListener(
    'input',
    () => {
      setSetting(
        'textSize',
        Number(
          sizeInput.value
        )
      )
    }
  )

  lineHeightInput?.addEventListener(
    'input',
    () => {
      setSetting(
        'lineHeight',
        Number(
          lineHeightInput.value
        )
      )
    }
  )

  resetButton?.addEventListener(
    'click',
    () => {
      settings = {
        ...DEFAULTS,
      }

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
