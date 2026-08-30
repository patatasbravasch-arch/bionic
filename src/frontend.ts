export function setup(ctx) {
  const MESSAGE_SELECTOR = '[data-component="MessageContent"]'
  const SETTINGS_KEY = 'lumiverse:bionic-style-reading:v0.5'
  const WORD_RE = /\p{L}[\p{L}\p{M}\p{N}'’\-]*/gu

  const DEFAULTS = {
    bionicEnabled: true,
    fontEnabled: false,
    density: 'balanced',
    fixation: 35,
    weight: 600,
    font: 'inherit',
    customFont: '',
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

  let loadedFontFace = null
  let loadedFontUrl = null

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
        bionicEnabled:
          typeof saved.bionicEnabled === 'boolean'
            ? saved.bionicEnabled
            : DEFAULTS.bionicEnabled,

        fontEnabled:
          typeof saved.fontEnabled === 'boolean'
            ? saved.fontEnabled
            : DEFAULTS.fontEnabled,

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

        customFont:
          typeof saved.customFont === 'string'
            ? saved.customFont
            : DEFAULTS.customFont,

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

  function currentFont() {
    if (loadedFontFace) {
      return '"LumibionicCustomFile", sans-serif'
    }

    if (settings.font === 'custom') {
      const value = settings.customFont.trim()
      return value || 'inherit'
    }

    return settings.font || 'inherit'
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

    const multiplier = settings.fixation / 35
    let cut = Math.round(base * multiplier)

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
    ${MESSAGE_SELECTOR}.lumibionic-typography {
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

    ${MESSAGE_SELECTOR}.lumibionic-font-override
      *:not(code)
      :not(pre)
      :not(kbd)
      :not(samp)
      :not(button)
      :not(input)
      :not(textarea)
      :not(select)
      :not(option)
      :not(svg)
      :not(math) {
      font-family:
        var(--lumibionic-font-family, inherit)
        !important;
    }

    ${MESSAGE_SELECTOR}.lumibionic-font-override {
      font-family:
        var(--lumibionic-font-family, inherit)
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
      border-top: 1px solid rgba(127,127,127,0.2);
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
      background:
        rgba(127,127,127,0.08);

      font-family:
        var(--lumibionic-preview-font, inherit)
        !important;

      font-size:
        var(--lumibionic-text-size, 100%);

      line-height:
        var(--lumibionic-line-height, 1.55);
    }

    .lumibionic-preview * {
      font-family:
        var(--lumibionic-preview-font, inherit)
        !important;
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
    description:
      'Bionic reading and font overrides',
    keywords: [
      'bionic',
      'reading',
      'font',
      'typography',
      'accessibility',
    ],
  })

  function processTextNode(node) {
    if (!settings.bionicEnabled) return

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

      const { chars, cut } =
        fixationCut(word)

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
        chars
          .slice(0, cut)
          .join('')

      wrapper.appendChild(fix)

      wrapper.appendChild(
        doc.createTextNode(
          chars
            .slice(cut)
            .join('')
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

  function applyMessageClasses(root) {
    root.classList.toggle(
      'lumibionic-typography',
      settings.fontEnabled
    )

    root.classList.toggle(
      'lumibionic-font-override',
      settings.fontEnabled
    )
  }

  function processMessage(root) {
    applyMessageClasses(root)

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
        MESSAGE_SELECTOR
      )
      .forEach(el => {
        el.classList.remove(
          'lumibionic-typography',
          'lumibionic-font-override'
        )

        el.normalize()
      })
  }

  function processAll() {
    if (rebuilding) return

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
    processAll()
  }

  function scheduleProcess() {
    if (
      scheduled ||
      rebuilding
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

    const font =
      currentFont()

    root.style.setProperty(
      '--lumibionic-weight',
      String(settings.weight)
    )

    root.style.setProperty(
      '--lumibionic-font-family',
      font
    )

    root.style.setProperty(
      '--lumibionic-preview-font',
      settings.fontEnabled
        ? font
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
  }

  function saveSettings() {
    try {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify(settings)
      )
    } catch {}
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
          Use Bionic-style emphasis, replace
          Lumiverse's message font, or use
          either feature independently.
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
            Override message font
          </label>

          <input
            id="lb-font-enabled"
            type="checkbox"
          >

        </div>

        <div class="lumibionic-muted">
          Forces the selected font on message
          text even when the Lumiverse theme
          declares another font.
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
              Enter any font installed on your
              device, or a normal CSS
              font-family stack.
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
              Optional. Local font files apply
              until this Lumiverse tab is closed
              or refreshed.
            </div>

          </div>

          <button
            type="button"
            id="lb-clear-font-file"
          >
            Stop using loaded font file
          </button>

        </div>

      </div>

      <div class="lumibionic-section">

        <div class="lumibionic-section-title">
          Typography
        </div>

        <div class="lumibionic-control">

          <div class="lumibionic-row">

            <label for="lb-size">
              Text size
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
              Line spacing
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

          <label>
            Preview
          </label>

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

  const bionicEnabled =
    $('#lb-bionic-enabled')

  const bionicOptions =
    $('#lb-bionic-options')

  const density =
    $('#lb-density')

  const fixation =
    $('#lb-fixation')

  const fixationValue =
    $('#lb-fixation-value')

  const weight =
    $('#lb-weight')

  const weightValue =
    $('#lb-weight-value')

  const fontEnabled =
    $('#lb-font-enabled')

  const fontOptions =
    $('#lb-font-options')

  const font =
    $('#lb-font')

  const customFontWrap =
    $('#lb-custom-font-wrap')

  const customFont =
    $('#lb-custom-font')

  const fontFile =
    $('#lb-font-file')

  const fontFileStatus =
    $('#lb-font-file-status')

  const clearFontFile =
    $('#lb-clear-font-file')

  const size =
    $('#lb-size')

  const sizeValue =
    $('#lb-size-value')

  const line =
    $('#lb-line')

  const lineValue =
    $('#lb-line-value')

  const preview =
    $('#lb-preview')

  const reset =
    $('#lb-reset')

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
    bionicEnabled.checked =
      settings.bionicEnabled

    bionicOptions.classList.toggle(
      'lumibionic-hidden',
      !settings.bionicEnabled
    )

    density.value =
      settings.density

    fixation.value =
      String(settings.fixation)

    fixationValue.textContent =
      `${settings.fixation}%`

    weight.value =
      String(settings.weight)

    weightValue.textContent =
      String(settings.weight)

    fontEnabled.checked =
      settings.fontEnabled

    fontOptions.classList.toggle(
      'lumibionic-hidden',
      !settings.fontEnabled
    )

    font.value =
      settings.font

    customFont.value =
      settings.customFont

    customFontWrap.classList.toggle(
      'lumibionic-hidden',
      settings.font !== 'custom'
    )

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

    if (settings.bionicEnabled) {
      processTextNode(sample)
    }
  }

  async function loadLocalFont(file) {
    if (!file) return

    if (
      loadedFontFace &&
      document.fonts
    ) {
      try {
        document.fonts.delete(
          loadedFontFace
        )
      } catch {}
    }

    if (loadedFontUrl) {
      URL.revokeObjectURL(
        loadedFontUrl
      )
    }

    loadedFontFace = null
    loadedFontUrl = null

    try {
      const url =
        URL.createObjectURL(file)

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
        '[Bionic Reading] Font load failed:',
        error
      )
    }
  }

  function unloadLocalFont() {
    if (
      loadedFontFace &&
      document.fonts
    ) {
      try {
        document.fonts.delete(
          loadedFontFace
        )
      } catch {}
    }

    if (loadedFontUrl) {
      URL.revokeObjectURL(
        loadedFontUrl
      )
    }

    loadedFontFace = null
    loadedFontUrl = null

    fontFile.value = ''

    fontFileStatus.textContent =
      'No local font file loaded.'

    applyCssSettings()
    processAll()
    renderPreview()
  }

  bionicEnabled.addEventListener(
    'change',
    () => {
      updateSetting(
        'bionicEnabled',
        bionicEnabled.checked,
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

  fontEnabled.addEventListener(
    'change',
    () => {
      updateSetting(
        'fontEnabled',
        fontEnabled.checked
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

  customFont.addEventListener(
    'input',
    () => {
      updateSetting(
        'customFont',
        customFont.value
      )
    }
  )

  fontFile.addEventListener(
    'change',
    () => {
      loadLocalFont(
        fontFile.files?.[0]
      )
    }
  )

  clearFontFile.addEventListener(
    'click',
    unloadLocalFont
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
      unloadLocalFont()

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
    unloadLocalFont()

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
      '--lumibionic-preview-font'
    )

    root.style.removeProperty(
      '--lumibionic-text-size'
    )

    root.style.removeProperty(
      '--lumibionic-line-height'
    )
  }
}
