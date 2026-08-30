export function setup(ctx) {
  const MESSAGE_SELECTOR = '[data-component="MessageContent"]'
  const SETTINGS_KEY = 'lumiverse:bionic-style-reading:v0.6'
  const WORD_RE = /\p{L}[\p{L}\p{M}\p{N}'’\-]*/gu

  const DEFAULTS = {
    bionicEnabled: true,
    density: 'balanced',
    fixation: 35,
    weight: 600,

    fontEnabled: false,
    font: 'inherit',
    customFont: '',

    scopeMessages: true,
    scopeBubble: false,
    scopeComposer: false,
    scopeMenus: false,
    scopeNavigation: false,
    scopeAll: false,

    justifyMessages: false,
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
    ['"Atkinson Hyperlegible", sans-serif', 'Atkinson Hyperlegible'],
    ['"OpenDyslexic", sans-serif', 'OpenDyslexic'],
    ['custom', 'Custom font / CSS stack'],
  ]

  const BIONIC_SKIP_SELECTOR = [
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

  let loadedFontFace = null
  let loadedFontUrl = null
  let settings = loadSettings()
  let scheduled = false
  let rebuilding = false

  const segmenter =
    typeof Intl.Segmenter === 'function'
      ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
      : null

  function clamp(value, min, max, fallback) {
    const n = Number(value)
    return Number.isFinite(n)
      ? Math.min(max, Math.max(min, n))
      : fallback
  }

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')

      return {
        ...DEFAULTS,

        bionicEnabled:
          typeof saved.bionicEnabled === 'boolean'
            ? saved.bionicEnabled
            : DEFAULTS.bionicEnabled,

        density:
          ['light', 'balanced', 'full'].includes(saved.density)
            ? saved.density
            : DEFAULTS.density,

        fixation: clamp(saved.fixation, 20, 70, DEFAULTS.fixation),
        weight: clamp(saved.weight, 500, 900, DEFAULTS.weight),

        fontEnabled:
          typeof saved.fontEnabled === 'boolean'
            ? saved.fontEnabled
            : DEFAULTS.fontEnabled,

        font:
          typeof saved.font === 'string'
            ? saved.font
            : DEFAULTS.font,

        customFont:
          typeof saved.customFont === 'string'
            ? saved.customFont
            : DEFAULTS.customFont,

        scopeMessages:
          typeof saved.scopeMessages === 'boolean'
            ? saved.scopeMessages
            : DEFAULTS.scopeMessages,

        scopeBubble:
          typeof saved.scopeBubble === 'boolean'
            ? saved.scopeBubble
            : DEFAULTS.scopeBubble,

        scopeComposer:
          typeof saved.scopeComposer === 'boolean'
            ? saved.scopeComposer
            : DEFAULTS.scopeComposer,

        scopeMenus:
          typeof saved.scopeMenus === 'boolean'
            ? saved.scopeMenus
            : DEFAULTS.scopeMenus,

        scopeNavigation:
          typeof saved.scopeNavigation === 'boolean'
            ? saved.scopeNavigation
            : DEFAULTS.scopeNavigation,

        scopeAll:
          typeof saved.scopeAll === 'boolean'
            ? saved.scopeAll
            : DEFAULTS.scopeAll,

        justifyMessages:
          typeof saved.justifyMessages === 'boolean'
            ? saved.justifyMessages
            : DEFAULTS.justifyMessages,

        textSize: clamp(saved.textSize, 80, 140, DEFAULTS.textSize),
        lineHeight: clamp(saved.lineHeight, 1.1, 2.2, DEFAULTS.lineHeight),
      }
    } catch {
      return { ...DEFAULTS }
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
    } catch {}
  }

  function graphemes(value) {
    if (!segmenter) return Array.from(value)

    return Array.from(
      segmenter.segment(value),
      part => part.segment
    )
  }

  function currentFont() {
    if (loadedFontFace) {
      return '"LumibionicCustomFile", sans-serif'
    }

    if (settings.font === 'custom') {
      return settings.customFont.trim() || 'inherit'
    }

    return settings.font || 'inherit'
  }

  function shouldEmphasize(length) {
    if (settings.density === 'light') return length >= 6
    if (settings.density === 'balanced') return length >= 4
    return length >= 2
  }

  function fixationCut(word) {
    const chars = graphemes(word)
    const length = chars.length

    if (!shouldEmphasize(length)) {
      return { chars, cut: 0 }
    }

    let base

    if (length <= 5) base = 1
    else if (length <= 8) base = 2
    else if (length <= 11) base = 3
    else base = 4

    const multiplier = settings.fixation / 35
    let cut = Math.round(base * multiplier)

    cut = Math.max(
      1,
      Math.min(cut, 4, length - 1)
    )

    return { chars, cut }
  }

  const removeStyle = ctx.dom.addStyle(`
    /*
     * Font reach is controlled by classes placed on <html>.
     * The broad rules intentionally use !important so custom themes
     * cannot silently win the font-family cascade.
     */

    html.lb-font-messages ${MESSAGE_SELECTOR},
    html.lb-font-messages ${MESSAGE_SELECTOR} * {
      font-family: var(--lumibionic-font-family, inherit) !important;
    }

    html.lb-font-bubble .lumibionic-bubble-scope,
    html.lb-font-bubble .lumibionic-bubble-scope * {
      font-family: var(--lumibionic-font-family, inherit) !important;
    }

    html.lb-font-composer textarea,
    html.lb-font-composer input,
    html.lb-font-composer [contenteditable="true"],
    html.lb-font-composer form button,
    html.lb-font-composer form button * {
      font-family: var(--lumibionic-font-family, inherit) !important;
    }

    html.lb-font-menus [role="menu"],
    html.lb-font-menus [role="menu"] *,
    html.lb-font-menus [role="menuitem"],
    html.lb-font-menus [role="menuitem"] *,
    html.lb-font-menus [role="listbox"],
    html.lb-font-menus [role="listbox"] *,
    html.lb-font-menus [role="option"],
    html.lb-font-menus [role="option"] *,
    html.lb-font-menus [role="dialog"],
    html.lb-font-menus [role="dialog"] *,
    html.lb-font-menus [data-radix-popper-content-wrapper],
    html.lb-font-menus [data-radix-popper-content-wrapper] *,
    html.lb-font-menus [data-floating-ui-portal],
    html.lb-font-menus [data-floating-ui-portal] * {
      font-family: var(--lumibionic-font-family, inherit) !important;
    }

    html.lb-font-navigation nav,
    html.lb-font-navigation nav *,
    html.lb-font-navigation aside,
    html.lb-font-navigation aside *,
    html.lb-font-navigation header,
    html.lb-font-navigation header *,
    html.lb-font-navigation [role="navigation"],
    html.lb-font-navigation [role="navigation"] *,
    html.lb-font-navigation [role="tablist"],
    html.lb-font-navigation [role="tablist"] *,
    html.lb-font-navigation [role="tab"],
    html.lb-font-navigation [role="tab"] * {
      font-family: var(--lumibionic-font-family, inherit) !important;
    }

    html.lb-font-all body,
    html.lb-font-all body * {
      font-family: var(--lumibionic-font-family, inherit) !important;
    }

    /*
     * Preserve code readability even when "Entire interface" is enabled.
     */
    html.lb-font-messages ${MESSAGE_SELECTOR} code,
    html.lb-font-messages ${MESSAGE_SELECTOR} code *,
    html.lb-font-messages ${MESSAGE_SELECTOR} pre,
    html.lb-font-messages ${MESSAGE_SELECTOR} pre *,
    html.lb-font-bubble .lumibionic-bubble-scope code,
    html.lb-font-bubble .lumibionic-bubble-scope code *,
    html.lb-font-bubble .lumibionic-bubble-scope pre,
    html.lb-font-bubble .lumibionic-bubble-scope pre *,
    html.lb-font-all code,
    html.lb-font-all code *,
    html.lb-font-all pre,
    html.lb-font-all pre *,
    html.lb-font-all kbd,
    html.lb-font-all samp {
      font-family:
        "SF Mono",
        "Fira Code",
        "JetBrains Mono",
        "Menlo",
        "Consolas",
        monospace !important;
    }

    /*
     * Do not let font overrides interfere with SVG icon internals.
     */
    html.lb-font-all svg,
    html.lb-font-all svg * {
      font-family: initial !important;
    }

    ${MESSAGE_SELECTOR} {
      font-size: var(--lumibionic-text-size, 100%) !important;
      line-height: var(--lumibionic-line-height, 1.55) !important;
    }

    ${MESSAGE_SELECTOR}.lumibionic-justify {
      text-align: justify !important;
      text-justify: inter-word;
    }

    ${MESSAGE_SELECTOR}.lumibionic-justify p,
    ${MESSAGE_SELECTOR}.lumibionic-justify li,
    ${MESSAGE_SELECTOR}.lumibionic-justify blockquote {
      text-align: justify !important;
      text-justify: inter-word;
    }

    ${MESSAGE_SELECTOR}.lumibionic-justify pre,
    ${MESSAGE_SELECTOR}.lumibionic-justify code,
    ${MESSAGE_SELECTOR}.lumibionic-justify table,
    ${MESSAGE_SELECTOR}.lumibionic-justify th,
    ${MESSAGE_SELECTOR}.lumibionic-justify td,
    ${MESSAGE_SELECTOR}.lumibionic-justify button {
      text-align: initial !important;
    }

    [data-lumibionic-fix] {
      font-weight: var(--lumibionic-weight, 600) !important;
    }

    .lumibionic-settings {
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    .lumibionic-settings h2 {
      margin: 0;
      font-size: 17px;
    }

    .lumibionic-section {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding-top: 6px;
    }

    .lumibionic-section + .lumibionic-section {
      border-top: 1px solid rgba(127, 127, 127, 0.2);
      padding-top: 18px;
    }

    .lumibionic-section-title {
      font-size: 14px;
      font-weight: 700;
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

    .lumibionic-checks {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .lumibionic-check {
      display: flex;
      align-items: center;
      gap: 10px;
      min-height: 32px;
      font-size: 13px;
    }

    .lumibionic-check input {
      width: auto !important;
      flex: 0 0 auto;
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
    .lumibionic-settings input[type="text"],
    .lumibionic-settings input[type="file"],
    .lumibionic-settings button {
      width: 100%;
      box-sizing: border-box;
    }

    .lumibionic-settings select,
    .lumibionic-settings input[type="text"],
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
      background: rgba(127, 127, 127, 0.08);
      font-family: var(--lumibionic-preview-font, inherit) !important;
      font-size: var(--lumibionic-text-size, 100%);
      line-height: var(--lumibionic-line-height, 1.55);
    }

    .lumibionic-preview * {
      font-family: var(--lumibionic-preview-font, inherit) !important;
    }

    .lumibionic-preview.lb-preview-justify {
      text-align: justify;
      text-justify: inter-word;
    }

    .lumibionic-hidden {
      display: none !important;
    }

    .lumibionic-file-status {
      font-size: 12px;
      opacity: 0.75;
    }
  `)

  const tab = ctx.ui.registerDrawerTab({
    id: 'bionic-reading',
    title: 'Reading & Fonts',
    shortName: 'Reading',
    headerTitle: 'Reading & Fonts',
    description: 'Bionic reading, font reach, and typography',
    keywords: [
      'bionic',
      'reading',
      'font',
      'typography',
      'justify',
      'accessibility',
    ],
  })

  function processTextNode(node) {
    if (!settings.bionicEnabled) return

    const parent = node.parentElement
    if (!parent) return
    if (parent.closest(BIONIC_SKIP_SELECTOR)) return

    const text = node.nodeValue || ''
    if (!/\p{L}/u.test(text)) return

    const doc = node.ownerDocument
    const fragment = doc.createDocumentFragment()

    let lastIndex = 0
    let changed = false

    for (const match of text.matchAll(WORD_RE)) {
      const word = match[0]
      const index = match.index ?? 0
      const { chars, cut } = fixationCut(word)

      if (!cut) continue

      if (index > lastIndex) {
        fragment.appendChild(
          doc.createTextNode(text.slice(lastIndex, index))
        )
      }

      const wrapper = doc.createElement('span')
      wrapper.setAttribute('data-lumibionic-word', '')

      const fix = doc.createElement('span')
      fix.setAttribute('data-lumibionic-fix', '')
      fix.textContent = chars.slice(0, cut).join('')

      wrapper.appendChild(fix)
      wrapper.appendChild(
        doc.createTextNode(chars.slice(cut).join(''))
      )

      fragment.appendChild(wrapper)

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

  function findMessageShell(content) {
    let node = content.parentElement
    let best = node

    for (let depth = 0; node && depth < 5; depth++) {
      const count = node.querySelectorAll(MESSAGE_SELECTOR).length

      if (count !== 1) break

      best = node
      node = node.parentElement
    }

    return best
  }

  function refreshBubbleScopes() {
    document
      .querySelectorAll('.lumibionic-bubble-scope')
      .forEach(el => {
        el.classList.remove('lumibionic-bubble-scope')
      })

    if (!settings.fontEnabled || !settings.scopeBubble || settings.scopeAll) {
      return
    }

    document
      .querySelectorAll(MESSAGE_SELECTOR)
      .forEach(content => {
        const shell = findMessageShell(content)

        if (shell) {
          shell.classList.add('lumibionic-bubble-scope')
        }
      })
  }

  function processMessage(root) {
    root.classList.toggle(
      'lumibionic-justify',
      settings.justifyMessages
    )

    if (!settings.bionicEnabled) return

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
      .querySelectorAll('[data-lumibionic-word]')
      .forEach(el => {
        el.replaceWith(
          document.createTextNode(el.textContent || '')
        )
      })

    root
      .querySelectorAll(MESSAGE_SELECTOR)
      .forEach(el => {
        el.classList.remove('lumibionic-justify')
        el.normalize()
      })
  }

  function applyRootClasses() {
    const root = document.documentElement

    const enabled = settings.fontEnabled

    root.classList.toggle(
      'lb-font-messages',
      enabled && settings.scopeMessages && !settings.scopeAll
    )

    root.classList.toggle(
      'lb-font-bubble',
      enabled && settings.scopeBubble && !settings.scopeAll
    )

    root.classList.toggle(
      'lb-font-composer',
      enabled && settings.scopeComposer && !settings.scopeAll
    )

    root.classList.toggle(
      'lb-font-menus',
      enabled && settings.scopeMenus && !settings.scopeAll
    )

    root.classList.toggle(
      'lb-font-navigation',
      enabled && settings.scopeNavigation && !settings.scopeAll
    )

    root.classList.toggle(
      'lb-font-all',
      enabled && settings.scopeAll
    )
  }

  function applyCssSettings() {
    const root = document.documentElement
    const fontFamily = currentFont()

    root.style.setProperty(
      '--lumibionic-weight',
      String(settings.weight)
    )

    root.style.setProperty(
      '--lumibionic-font-family',
      fontFamily
    )

    root.style.setProperty(
      '--lumibionic-preview-font',
      settings.fontEnabled
        ? fontFamily
        : 'inherit'
    )

    root.style.setProperty(
      '--lumibionic-text-size',
      `${settings.textSize}%`
    )

    root.style.setProperty(
      '--lumibionic-line-height',
      String(settings.lineHeight)
    )

    applyRootClasses()
    refreshBubbleScopes()
  }

  function processAll() {
    if (rebuilding) return

    document
      .querySelectorAll(MESSAGE_SELECTOR)
      .forEach(processMessage)

    refreshBubbleScopes()
  }

  function rebuildAll() {
    rebuilding = true
    unwrap()
    rebuilding = false

    applyCssSettings()
    processAll()
  }

  function scheduleProcess() {
    if (scheduled || rebuilding) return

    scheduled = true

    requestAnimationFrame(() => {
      scheduled = false
      processAll()
    })
  }

  function updateSetting(key, value, rebuild = false) {
    settings = {
      ...settings,
      [key]: value,
    }

    saveSettings()
    applyCssSettings()
    syncControls()

    if (rebuild) {
      rebuildAll()
    } else {
      processAll()
    }

    renderPreview()
  }

  tab.root.innerHTML = `
    <div class="lumibionic-settings">

      <div>
        <h2>Reading & Fonts</h2>
        <div class="lumibionic-muted">
          Use Bionic emphasis, change typography,
          and choose exactly how far the font override reaches.
        </div>
      </div>

      <div class="lumibionic-section">

        <div class="lumibionic-section-title">
          Bionic emphasis
        </div>

        <div class="lumibionic-row">
          <label for="lb-bionic-enabled">
            Enable Bionic Reading
          </label>

          <input
            id="lb-bionic-enabled"
            type="checkbox"
          >
        </div>

        <div id="lb-bionic-options">

          <div class="lumibionic-control">
            <label for="lb-density">
              Emphasis density
            </label>

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
              <label for="lb-fixation">
                Fixation strength
              </label>
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
          </div>

          <div class="lumibionic-control">
            <div class="lumibionic-row">
              <label for="lb-weight">
                Emphasis weight
              </label>
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

        </div>
      </div>

      <div class="lumibionic-section">

        <div class="lumibionic-section-title">
          Font override
        </div>

        <div class="lumibionic-row">
          <label for="lb-font-enabled">
            Enable font override
          </label>
          <input
            id="lb-font-enabled"
            type="checkbox"
          >
        </div>

        <div id="lb-font-options">

          <div class="lumibionic-control">
            <label for="lb-font">
              Font
            </label>
            <select id="lb-font"></select>
          </div>

          <div
            class="lumibionic-control"
            id="lb-custom-font-wrap"
          >
            <label for="lb-custom-font">
              Custom font name / CSS stack
            </label>

            <input
              id="lb-custom-font"
              type="text"
              spellcheck="false"
              placeholder='"Atkinson Hyperlegible", sans-serif'
            >

            <div class="lumibionic-muted">
              Use a font installed on this device,
              or enter a normal CSS font-family stack.
            </div>
          </div>

          <div class="lumibionic-control">
            <label for="lb-font-file">
              Load a local font file
            </label>

            <input
              id="lb-font-file"
              type="file"
              accept=".woff,.woff2,.ttf,.otf,font/woff,font/woff2,font/ttf,font/otf"
            >

            <div
              class="lumibionic-file-status"
              id="lb-font-file-status"
            >
              Optional. The selected file lasts until
              the Lumiverse tab is refreshed.
            </div>
          </div>

          <button
            type="button"
            id="lb-clear-font-file"
          >
            Stop using loaded font file
          </button>

          <div class="lumibionic-control">
            <label>Font reach</label>

            <div class="lumibionic-checks">

              <label class="lumibionic-check">
                <input id="lb-scope-messages" type="checkbox">
                <span>Message text</span>
              </label>

              <label class="lumibionic-check">
                <input id="lb-scope-bubble" type="checkbox">
                <span>Message bubble, names & controls</span>
              </label>

              <label class="lumibionic-check">
                <input id="lb-scope-composer" type="checkbox">
                <span>Composer & text inputs</span>
              </label>

              <label class="lumibionic-check">
                <input id="lb-scope-menus" type="checkbox">
                <span>Menus, popovers & dialogs</span>
              </label>

              <label class="lumibionic-check">
                <input id="lb-scope-navigation" type="checkbox">
                <span>Navigation, tabs & panels</span>
              </label>

              <label class="lumibionic-check">
                <input id="lb-scope-all" type="checkbox">
                <span><strong>Entire Lumiverse interface</strong></span>
              </label>

            </div>

            <div class="lumibionic-muted">
              “Entire interface” takes priority over the
              individual reach checkboxes. Code blocks remain monospace.
            </div>
          </div>

        </div>
      </div>

      <div class="lumibionic-section">

        <div class="lumibionic-section-title">
          Message layout
        </div>

        <label class="lumibionic-check">
          <input id="lb-justify" type="checkbox">
          <span>Justify message prose</span>
        </label>

        <div class="lumibionic-muted">
          Applies text justification to prose while leaving
          code blocks and tables alone.
        </div>

        <div class="lumibionic-control">
          <div class="lumibionic-row">
            <label for="lb-size">
              Message text size
            </label>
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
            <label for="lb-line">
              Message line spacing
            </label>
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

      </div>

      <div class="lumibionic-section">
        <div class="lumibionic-control">
          <label>Preview</label>
          <div
            class="lumibionic-preview"
            id="lb-preview"
          ></div>
        </div>
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

  const bionicEnabled = $('#lb-bionic-enabled')
  const bionicOptions = $('#lb-bionic-options')
  const density = $('#lb-density')
  const fixation = $('#lb-fixation')
  const fixationValue = $('#lb-fixation-value')
  const weight = $('#lb-weight')
  const weightValue = $('#lb-weight-value')

  const fontEnabled = $('#lb-font-enabled')
  const fontOptions = $('#lb-font-options')
  const font = $('#lb-font')
  const customFontWrap = $('#lb-custom-font-wrap')
  const customFont = $('#lb-custom-font')
  const fontFile = $('#lb-font-file')
  const fontFileStatus = $('#lb-font-file-status')
  const clearFontFile = $('#lb-clear-font-file')

  const scopeMessages = $('#lb-scope-messages')
  const scopeBubble = $('#lb-scope-bubble')
  const scopeComposer = $('#lb-scope-composer')
  const scopeMenus = $('#lb-scope-menus')
  const scopeNavigation = $('#lb-scope-navigation')
  const scopeAll = $('#lb-scope-all')

  const justify = $('#lb-justify')
  const size = $('#lb-size')
  const sizeValue = $('#lb-size-value')
  const line = $('#lb-line')
  const lineValue = $('#lb-line-value')

  const preview = $('#lb-preview')
  const reset = $('#lb-reset')

  for (const [value, label] of FONT_OPTIONS) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    font.appendChild(option)
  }

  function syncControls() {
    bionicEnabled.checked = settings.bionicEnabled

    bionicOptions.classList.toggle(
      'lumibionic-hidden',
      !settings.bionicEnabled
    )

    density.value = settings.density
    fixation.value = String(settings.fixation)
    fixationValue.textContent = `${settings.fixation}%`

    weight.value = String(settings.weight)
    weightValue.textContent = String(settings.weight)

    fontEnabled.checked = settings.fontEnabled

    fontOptions.classList.toggle(
      'lumibionic-hidden',
      !settings.fontEnabled
    )

    font.value = settings.font
    customFont.value = settings.customFont

    customFontWrap.classList.toggle(
      'lumibionic-hidden',
      settings.font !== 'custom'
    )

    scopeMessages.checked = settings.scopeMessages
    scopeBubble.checked = settings.scopeBubble
    scopeComposer.checked = settings.scopeComposer
    scopeMenus.checked = settings.scopeMenus
    scopeNavigation.checked = settings.scopeNavigation
    scopeAll.checked = settings.scopeAll

    const individualScopes = [
      scopeMessages,
      scopeBubble,
      scopeComposer,
      scopeMenus,
      scopeNavigation,
    ]

    for (const input of individualScopes) {
      input.disabled = settings.scopeAll
    }

    justify.checked = settings.justifyMessages

    size.value = String(settings.textSize)
    sizeValue.textContent = `${settings.textSize}%`

    line.value = String(settings.lineHeight)
    lineValue.textContent = settings.lineHeight.toFixed(2)
  }

  function renderPreview() {
    preview.replaceChildren()

    preview.classList.toggle(
      'lb-preview-justify',
      settings.justifyMessages
    )

    const sample =
      document.createTextNode(
        'A dry mocking chuckle shook his chest as he leaned closer toward the doorway. The longer line makes justified spacing easier to judge.'
      )

    preview.appendChild(sample)

    if (settings.bionicEnabled) {
      processTextNode(sample)
    }
  }

  async function loadLocalFont(file) {
    if (!file) return

    unloadLocalFont(false)

    try {
      const url = URL.createObjectURL(file)

      const face =
        new FontFace(
          'LumibionicCustomFile',
          `url("${url}")`
        )

      await face.load()
      document.fonts.add(face)

      loadedFontFace = face
      loadedFontUrl = url

      fontFileStatus.textContent =
        `Using local font: ${file.name}`

      settings.fontEnabled = true

      saveSettings()
      applyCssSettings()
      syncControls()
      processAll()
      renderPreview()

    } catch (error) {
      fontFileStatus.textContent =
        'Could not load that font file.'

      console.error(
        '[Reading & Fonts] Font load failed:',
        error
      )
    }
  }

  function unloadLocalFont(refresh = true) {
    if (loadedFontFace && document.fonts) {
      try {
        document.fonts.delete(loadedFontFace)
      } catch {}
    }

    if (loadedFontUrl) {
      URL.revokeObjectURL(loadedFontUrl)
    }

    loadedFontFace = null
    loadedFontUrl = null

    if (fontFile) {
      fontFile.value = ''
    }

    if (fontFileStatus) {
      fontFileStatus.textContent =
        'No local font file loaded.'
    }

    if (refresh) {
      applyCssSettings()
      processAll()
      renderPreview()
    }
  }

  bionicEnabled.addEventListener(
    'change',
    () => updateSetting(
      'bionicEnabled',
      bionicEnabled.checked,
      true
    )
  )

  density.addEventListener(
    'change',
    () => updateSetting(
      'density',
      density.value,
      true
    )
  )

  fixation.addEventListener(
    'input',
    () => updateSetting(
      'fixation',
      Number(fixation.value),
      true
    )
  )

  weight.addEventListener(
    'input',
    () => updateSetting(
      'weight',
      Number(weight.value)
    )
  )

  fontEnabled.addEventListener(
    'change',
    () => updateSetting(
      'fontEnabled',
      fontEnabled.checked
    )
  )

  font.addEventListener(
    'change',
    () => updateSetting(
      'font',
      font.value
    )
  )

  customFont.addEventListener(
    'input',
    () => updateSetting(
      'customFont',
      customFont.value
    )
  )

  fontFile.addEventListener(
    'change',
    () => loadLocalFont(
      fontFile.files?.[0]
    )
  )

  clearFontFile.addEventListener(
    'click',
    () => unloadLocalFont(true)
  )

  const scopeBindings = [
    [scopeMessages, 'scopeMessages'],
    [scopeBubble, 'scopeBubble'],
    [scopeComposer, 'scopeComposer'],
    [scopeMenus, 'scopeMenus'],
    [scopeNavigation, 'scopeNavigation'],
    [scopeAll, 'scopeAll'],
  ]

  for (const [input, key] of scopeBindings) {
    input.addEventListener(
      'change',
      () => updateSetting(
        key,
        input.checked
      )
    )
  }

  justify.addEventListener(
    'change',
    () => updateSetting(
      'justifyMessages',
      justify.checked
    )
  )

  size.addEventListener(
    'input',
    () => updateSetting(
      'textSize',
      Number(size.value)
    )
  )

  line.addEventListener(
    'input',
    () => updateSetting(
      'lineHeight',
      Number(line.value)
    )
  )

  reset.addEventListener(
    'click',
    () => {
      unloadLocalFont(false)

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
    unloadLocalFont(false)

    document
      .querySelectorAll('.lumibionic-bubble-scope')
      .forEach(el => {
        el.classList.remove('lumibionic-bubble-scope')
      })

    const root = document.documentElement

    for (const className of [
      'lb-font-messages',
      'lb-font-bubble',
      'lb-font-composer',
      'lb-font-menus',
      'lb-font-navigation',
      'lb-font-all',
    ]) {
      root.classList.remove(className)
    }

    for (const property of [
      '--lumibionic-weight',
      '--lumibionic-font-family',
      '--lumibionic-preview-font',
      '--lumibionic-text-size',
      '--lumibionic-line-height',
    ]) {
      root.style.removeProperty(property)
    }

    tab.destroy()
    removeStyle()
    ctx.dom.cleanup()
  }
}
