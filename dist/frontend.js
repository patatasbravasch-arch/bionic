export function setup(ctx) {
  const MESSAGE_SELECTOR = '[data-component="MessageContent"]'
  const SETTINGS_KEY = 'lumiverse:bionic-style-reading:v0.25'
  const LEGACY_SETTINGS_KEYS = [
    'lumiverse:bionic-style-reading:v0.24',
    'lumiverse:bionic-style-reading:v0.23',
    'lumiverse:bionic-style-reading:v0.22',
    'lumiverse:bionic-style-reading:v0.21',
    'lumiverse:bionic-style-reading:v0.20',
    'lumiverse:bionic-style-reading:v0.19',
    'lumiverse:bionic-style-reading:v0.18',
    'lumiverse:bionic-style-reading:v0.17',
    'lumiverse:bionic-style-reading:v0.16',
    'lumiverse:bionic-style-reading:v0.15',
    'lumiverse:bionic-style-reading:v0.14',
    'lumiverse:bionic-style-reading:v0.13',
    'lumiverse:bionic-style-reading:v0.12',
    'lumiverse:bionic-style-reading:v0.11',
    'lumiverse:bionic-style-reading:v0.10',
    'lumiverse:bionic-style-reading:v0.9',
    'lumiverse:bionic-style-reading:v0.8',
    'lumiverse:bionic-style-reading:v0.7',
  ]
  const UI_STATE_KEY = 'lumiverse:bionic-style-ui:v0.25'
  const WORD_RE = /\p{L}[\p{L}\p{M}\p{N}'’\-]*/gu

  const TOOLBAR_BUTTONS = [
    { key: 'backHome', label: 'Back to home', title: 'Back to home', className: 'lb-hide-toolbar-back-home' },
    { key: 'regenerate', label: 'Regenerate', title: 'Regenerate', className: 'lb-hide-toolbar-regenerate' },
    { key: 'continue', label: 'Continue', title: 'Continue', className: 'lb-hide-toolbar-continue' },
    { key: 'oneLiner', label: 'One-liner nudge', title: 'One-liner: Chat history + impersonation nudge only', className: 'lb-hide-toolbar-one-liner' },
    { key: 'persona', label: 'Switch persona', title: 'Switch persona for this chat', className: 'lb-hide-toolbar-persona' },
    { key: 'connection', label: 'Connection', title: 'Connection:', className: 'lb-hide-toolbar-connection' },
    { key: 'alternateFields', label: 'Alternate fields', title: 'Alternate fields', className: 'lb-hide-toolbar-alternate-fields' },
    { key: 'guidedGenerations', label: 'Guided generations', title: 'Guided generations', className: 'lb-hide-toolbar-guided' },
    { key: 'quickReplies', label: 'Quick replies', title: 'Quick replies', className: 'lb-hide-toolbar-quick-replies' },
    { key: 'tools', label: 'Tools', title: 'Tools', className: 'lb-hide-toolbar-tools' },
    { key: 'extras', label: 'Extras', title: 'Extras', className: 'lb-hide-toolbar-extras' },
    {
      key: 'attachments',
      label: 'Attachments / paperclip',
      title: 'Attach',
      titles: [
        'attach',
        'attachment',
        'attachments',
        'attach file',
        'attach files',
        'add attachment',
        'add attachments',
        'upload file',
        'upload files'
      ],
      className: 'lb-hide-toolbar-attachments'
    },
  ]

  const DEFAULT_TOOLBAR_HIDDEN = Object.fromEntries(
    TOOLBAR_BUTTONS.map(item => [item.key, false])
  )

  const DEFAULTS = {
    preset: 'custom',
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
    hyphenateMessages: false,
    readingWidth: 'full',
    paragraphSpacing: 0,
    letterSpacing: 0,
    wordSpacing: 0,
    textSize: 100,
    lineHeight: 1.55,

    ffThinkFixEnabled: false,
    ffThinkBoundaryText: '[ 🕰️ Time',

    toolbarSpacing: 4,
    toolbarHidden: { ...DEFAULT_TOOLBAR_HIDDEN },
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

  const WIDTH_OPTIONS = [
    ['full', 'Full width'],
    ['55ch', '55 characters — narrow'],
    ['65ch', '65 characters — comfortable'],
    ['75ch', '75 characters — relaxed'],
    ['85ch', '85 characters — wide'],
  ]

  const PRESETS = {
    clean: {
      bionicEnabled: false,
      justifyMessages: false,
      hyphenateMessages: false,
      readingWidth: 'full',
      paragraphSpacing: 0,
      letterSpacing: 0,
      wordSpacing: 0,
      textSize: 100,
      lineHeight: 1.55,
    },
    comfortable: {
      bionicEnabled: false,
      justifyMessages: true,
      hyphenateMessages: true,
      readingWidth: '65ch',
      paragraphSpacing: 0.6,
      letterSpacing: 0.01,
      wordSpacing: 0.02,
      textSize: 105,
      lineHeight: 1.6,
    },
    mobile: {
      bionicEnabled: false,
      justifyMessages: true,
      hyphenateMessages: true,
      readingWidth: 'full',
      paragraphSpacing: 0.5,
      letterSpacing: 0.005,
      wordSpacing: 0.01,
      textSize: 105,
      lineHeight: 1.6,
    },
    bionicLight: {
      bionicEnabled: true,
      density: 'light',
      fixation: 30,
      weight: 600,
      justifyMessages: true,
      hyphenateMessages: true,
      readingWidth: '65ch',
      paragraphSpacing: 0.5,
      letterSpacing: 0.005,
      wordSpacing: 0.01,
      textSize: 100,
      lineHeight: 1.6,
    },
  }

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
      const raw =
        localStorage.getItem(SETTINGS_KEY) ||
        LEGACY_SETTINGS_KEYS
          .map(key => localStorage.getItem(key))
          .find(Boolean) ||
        '{}'

      const saved = JSON.parse(raw)

      return {
        ...DEFAULTS,

        preset:
          ['custom', 'clean', 'comfortable', 'mobile', 'bionicLight'].includes(saved.preset)
            ? saved.preset
            : 'custom',

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

        hyphenateMessages:
          typeof saved.hyphenateMessages === 'boolean'
            ? saved.hyphenateMessages
            : DEFAULTS.hyphenateMessages,

        readingWidth:
          WIDTH_OPTIONS.some(([value]) => value === saved.readingWidth)
            ? saved.readingWidth
            : DEFAULTS.readingWidth,

        paragraphSpacing: clamp(
          saved.paragraphSpacing,
          0,
          1.5,
          DEFAULTS.paragraphSpacing
        ),

        letterSpacing: clamp(
          saved.letterSpacing,
          -0.03,
          0.12,
          DEFAULTS.letterSpacing
        ),

        wordSpacing: clamp(
          saved.wordSpacing,
          -0.05,
          0.3,
          DEFAULTS.wordSpacing
        ),

        textSize: clamp(saved.textSize, 80, 140, DEFAULTS.textSize),
        lineHeight: clamp(saved.lineHeight, 1.1, 2.2, DEFAULTS.lineHeight),

        ffThinkFixEnabled:
          typeof saved.ffThinkFixEnabled === 'boolean'
            ? saved.ffThinkFixEnabled
            : DEFAULTS.ffThinkFixEnabled,

        ffThinkBoundaryText:
          typeof saved.ffThinkBoundaryText === 'string'
            ? saved.ffThinkBoundaryText
            : DEFAULTS.ffThinkBoundaryText,

        toolbarSpacing: clamp(
          saved.toolbarSpacing,
          0,
          16,
          DEFAULTS.toolbarSpacing
        ),

        toolbarHidden: Object.fromEntries(
          TOOLBAR_BUTTONS.map(item => [
            item.key,
            typeof saved.toolbarHidden?.[item.key] === 'boolean'
              ? saved.toolbarHidden[item.key]
              : DEFAULT_TOOLBAR_HIDDEN[item.key],
          ])
        ),
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

    ${MESSAGE_SELECTOR}.lumibionic-hyphens,
    ${MESSAGE_SELECTOR}.lumibionic-hyphens p,
    ${MESSAGE_SELECTOR}.lumibionic-hyphens li,
    ${MESSAGE_SELECTOR}.lumibionic-hyphens blockquote {
      hyphens: auto !important;
      -webkit-hyphens: auto !important;
    }

    ${MESSAGE_SELECTOR}.lumibionic-hyphens pre,
    ${MESSAGE_SELECTOR}.lumibionic-hyphens code,
    ${MESSAGE_SELECTOR}.lumibionic-hyphens table {
      hyphens: none !important;
      -webkit-hyphens: none !important;
    }

    ${MESSAGE_SELECTOR}.lumibionic-reading-width {
      max-width: var(--lumibionic-reading-width) !important;
    }

    ${MESSAGE_SELECTOR}.lumibionic-paragraph-spacing p {
      margin-block-start: 0 !important;
      margin-block-end: var(--lumibionic-paragraph-spacing) !important;
    }

    ${MESSAGE_SELECTOR}.lumibionic-paragraph-spacing p:last-child {
      margin-block-end: 0 !important;
    }

    ${MESSAGE_SELECTOR}.lumibionic-letter-spacing,
    ${MESSAGE_SELECTOR}.lumibionic-letter-spacing p,
    ${MESSAGE_SELECTOR}.lumibionic-letter-spacing li,
    ${MESSAGE_SELECTOR}.lumibionic-letter-spacing blockquote,
    ${MESSAGE_SELECTOR}.lumibionic-letter-spacing a,
    ${MESSAGE_SELECTOR}.lumibionic-letter-spacing span,
    ${MESSAGE_SELECTOR}.lumibionic-letter-spacing em,
    ${MESSAGE_SELECTOR}.lumibionic-letter-spacing strong {
      letter-spacing: var(--lumibionic-letter-spacing) !important;
    }

    ${MESSAGE_SELECTOR}.lumibionic-word-spacing,
    ${MESSAGE_SELECTOR}.lumibionic-word-spacing p,
    ${MESSAGE_SELECTOR}.lumibionic-word-spacing li,
    ${MESSAGE_SELECTOR}.lumibionic-word-spacing blockquote,
    ${MESSAGE_SELECTOR}.lumibionic-word-spacing a,
    ${MESSAGE_SELECTOR}.lumibionic-word-spacing span,
    ${MESSAGE_SELECTOR}.lumibionic-word-spacing em,
    ${MESSAGE_SELECTOR}.lumibionic-word-spacing strong {
      word-spacing: var(--lumibionic-word-spacing) !important;
    }

    ${MESSAGE_SELECTOR}.lumibionic-letter-spacing code,
    ${MESSAGE_SELECTOR}.lumibionic-letter-spacing pre {
      letter-spacing: normal !important;
    }

    ${MESSAGE_SELECTOR}.lumibionic-word-spacing code,
    ${MESSAGE_SELECTOR}.lumibionic-word-spacing pre {
      word-spacing: normal !important;
    }

    [data-lumibionic-fix] {
      font-weight: var(--lumibionic-weight, 600) !important;
    }

    /* Chat toolbar visibility — exact title matches requested by the user. */
    html.lb-hide-toolbar-back-home
    [data-component="InputArea"] [data-spindle-mount="chat_toolbar"]
    button[title*="Back to home"] {
      display: none !important;
    }

    html.lb-hide-toolbar-regenerate
    [data-component="InputArea"] [data-spindle-mount="chat_toolbar"]
    button[title*="Regenerate"] {
      display: none !important;
    }

    html.lb-hide-toolbar-continue
    [data-component="InputArea"] [data-spindle-mount="chat_toolbar"]
    button[title*="Continue"] {
      display: none !important;
    }

    html.lb-hide-toolbar-one-liner
    [data-component="InputArea"] [data-spindle-mount="chat_toolbar"]
    button[title*="One-liner: Chat history + impersonation nudge only"] {
      display: none !important;
    }

    html.lb-hide-toolbar-persona
    [data-component="InputArea"] [data-spindle-mount="chat_toolbar"]
    button[title*="Switch persona for this chat"] {
      display: none !important;
    }

    html.lb-hide-toolbar-connection
    [data-component="InputArea"] [data-spindle-mount="chat_toolbar"]
    button[title*="Connection:"] {
      display: none !important;
    }

    html.lb-hide-toolbar-alternate-fields
    [data-component="InputArea"] [data-spindle-mount="chat_toolbar"]
    button[title*="Alternate fields"] {
      display: none !important;
    }

    html.lb-hide-toolbar-guided
    [data-component="InputArea"] [data-spindle-mount="chat_toolbar"]
    button[title*="Guided generations"] {
      display: none !important;
    }

    html.lb-hide-toolbar-quick-replies
    [data-component="InputArea"] [data-spindle-mount="chat_toolbar"]
    button[title*="Quick replies"] {
      display: none !important;
    }

    html.lb-hide-toolbar-tools
    [data-component="InputArea"] [data-spindle-mount="chat_toolbar"]
    button[title*="Tools"] {
      display: none !important;
    }

    html.lb-hide-toolbar-extras
    [data-component="InputArea"] [data-spindle-mount="chat_toolbar"]
    button[title*="Extras"] {
      display: none !important;
    }

    .lumibionic-settings {
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
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
      padding-top: 10px;
    }

    .lumibionic-section-title {
      font-size: 14px;
      font-weight: 700;
    }


    .lumibionic-section-toggle {
      width: 100% !important;
      padding: 6px 0 !important;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      border: 0;
      background: transparent;
      text-align: left;
      font-size: 14px;
      font-weight: 700;
    }

    .lumibionic-section-toggle::after {
      content: "▾";
      opacity: 0.62;
      transition: transform 120ms ease;
    }

    .lumibionic-section-toggle[aria-expanded="false"]::after {
      transform: rotate(-90deg);
    }

    .lumibionic-section-body {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .lumibionic-section-body.lumibionic-section-collapsed {
      display: none !important;
    }

    .lumibionic-preview-section {
      position: sticky;
      top: 0;
      z-index: 30;
      margin: 0 -8px;
      padding: 10px 8px 12px !important;
      border-top: 0 !important;
      border-bottom: 1px solid rgba(127, 127, 127, 0.22);
      background: color-mix(in srgb, var(--lumiverse-bg, #080812) 92%, transparent);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
    }

    .lumibionic-preview-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 8px;
    }

    .lumibionic-preview-toolbar strong {
      font-size: 13px;
    }

    .lumibionic-preview-toolbar button {
      width: auto !important;
      padding: 6px 9px !important;
      font-size: 12px;
    }

    .lumibionic-ui-actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }

    .lumibionic-ff-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }

    .lumibionic-ff-grid .lumibionic-control {
      min-width: 0;
    }

    .lumibionic-ff-grid input[type="text"] {
      width: 100%;
      box-sizing: border-box;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }

    @media (max-width: 720px) {
      .lumibionic-ff-grid {
        grid-template-columns: 1fr;
      }
    }

    .lumibionic-toolbar-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }

    .lumibionic-toolbar-toggle {
      min-height: 48px;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      justify-content: center;
      gap: 2px;
      text-align: left;
      border: 1px solid rgba(127, 127, 127, 0.22);
      background: rgba(127, 127, 127, 0.04);
    }

    .lumibionic-toolbar-toggle small {
      opacity: 0.64;
      font-size: 11px;
    }

    .lumibionic-toolbar-toggle[data-hidden="true"] {
      border-color: color-mix(in srgb, var(--lumiverse-primary, #7c9bc8) 58%, transparent);
      background: color-mix(in srgb, var(--lumiverse-primary, #7c9bc8) 13%, transparent);
    }

    .lumibionic-toolbar-actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }

    @media (max-width: 440px) {
      .lumibionic-toolbar-grid {
        grid-template-columns: 1fr;
      }
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

    .lumibionic-stepper {
      display: none;
      grid-template-columns: 44px minmax(72px, 1fr) 44px 44px;
      gap: 6px;
      align-items: center;
    }

    .lumibionic-stepper button,
    .lumibionic-stepper input {
      min-height: 44px;
      box-sizing: border-box;
    }

    .lumibionic-stepper button {
      width: auto !important;
      padding: 0 8px !important;
      font-size: 18px;
      line-height: 1;
    }

    .lumibionic-stepper input {
      width: 100% !important;
      padding: 8px !important;
      text-align: center;
      font: inherit;
      font-size: 16px;
      border-radius: 8px;
    }

    .lumibionic-stepper-reset {
      font-size: 16px !important;
    }

    @media (hover: none), (pointer: coarse) {
      .lumibionic-mobile-safe-range {
        display: none !important;
      }

      .lumibionic-stepper {
        display: grid;
      }
    }

    .lumibionic-preview {
      padding: 12px;
      border-radius: 8px;
      background: rgba(127, 127, 127, 0.08);
      font-family: var(--lumibionic-preview-font, inherit) !important;
      font-size: var(--lumibionic-text-size, 100%);
      line-height: var(--lumibionic-line-height, 1.55);
      letter-spacing: var(--lumibionic-preview-letter-spacing, normal);
      word-spacing: var(--lumibionic-preview-word-spacing, normal);
      hyphens: var(--lumibionic-preview-hyphens, manual);
      -webkit-hyphens: var(--lumibionic-preview-hyphens, manual);

      /* Keep live preview useful without taking over the drawer. */
      max-height: min(170px, 24vh);
      overflow-y: auto;
      overscroll-behavior: contain;
      scrollbar-gutter: stable;
    }

    @media (max-width: 720px) {
      .lumibionic-preview {
        max-height: min(150px, 21vh);
        padding: 10px;
      }
    }

    .lumibionic-preview * {
      font-family: var(--lumibionic-preview-font, inherit) !important;
    }

    .lumibionic-preview.lb-preview-justify {
      text-align: justify;
      text-justify: inter-word;
    }

    .lumibionic-preview p {
      margin: 0 !important;
      padding: 0 !important;
    }

    .lumibionic-preview p + p {
      margin-block-start:
        var(--lumibionic-paragraph-spacing, 0em) !important;
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
    description: 'Bionic reading, font reach, and long-form typography',
    keywords: [
      'bionic',
      'reading',
      'font',
      'typography',
      'justify',
      'hyphenation',
      'spacing',
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

    root.classList.toggle(
      'lumibionic-hyphens',
      settings.hyphenateMessages
    )

    root.classList.toggle(
      'lumibionic-reading-width',
      settings.readingWidth !== 'full'
    )

    root.classList.toggle(
      'lumibionic-paragraph-spacing',
      settings.paragraphSpacing > 0.001
    )

    root.classList.toggle(
      'lumibionic-letter-spacing',
      Math.abs(settings.letterSpacing) > 0.0001
    )

    root.classList.toggle(
      'lumibionic-word-spacing',
      Math.abs(settings.wordSpacing) > 0.0001
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
        el.classList.remove(
          'lumibionic-justify',
          'lumibionic-hyphens',
          'lumibionic-reading-width',
          'lumibionic-paragraph-spacing',
          'lumibionic-letter-spacing',
          'lumibionic-word-spacing'
        )
        el.normalize()
      })
  }


  function toolbarButtonLabel(button) {
    return [
      button.getAttribute('title') || '',
      button.getAttribute('aria-label') || '',
      button.getAttribute('data-tooltip') || '',
      button.getAttribute('data-title') || '',
    ]
      .filter(Boolean)
      .join(' ')
      .trim()
  }

  function isAttachmentButton(button) {
    if (!button?.matches?.('button')) return false
    if (!button.closest('[data-component="InputArea"]')) return false

    const previous = button.previousElementSibling
    if (
      previous?.matches?.(
        '[data-spindle-mount="chat_input_tools_left"]'
      )
    ) {
      return true
    }

    return Boolean(
      button.querySelector(
        'svg.lucide-paperclip, svg[class*="paperclip"]'
      )
    )
  }

  function toolbarItemForButton(button) {
    if (isAttachmentButton(button)) {
      return TOOLBAR_BUTTONS.find(
        item => item.key === 'attachments'
      ) || null
    }

    const label =
      toolbarButtonLabel(button).toLocaleLowerCase()

    if (!label) return null

    return TOOLBAR_BUTTONS.find(item => {
      const aliases =
        Array.isArray(item.titles) && item.titles.length
          ? item.titles
          : [item.title]

      return aliases.some(alias =>
        label.includes(
          String(alias).toLocaleLowerCase()
        )
      )
    }) || null
  }

  function findToolbarButtons() {
    const buttons = new Set()

    document
      .querySelectorAll(
        '[data-component="InputArea"] button, ' +
        '[data-spindle-mount="chat_toolbar"] button'
      )
      .forEach(button => buttons.add(button))

    return Array.from(buttons)
  }

  function applyToolbarVisibility() {
    let matched = 0
    let hidden = 0

    const spacing = clamp(
      settings.toolbarSpacing,
      0,
      16,
      DEFAULTS.toolbarSpacing
    )
    const halfSpacing = spacing / 2

    for (const button of findToolbarButtons()) {
      /*
        Apply the chosen total gap as half-margin on each button.
        Two neighboring buttons therefore produce the requested gap.
        Inline !important intentionally wins over theme CSS.
      */
      button.style.setProperty(
        'margin-inline',
        `${halfSpacing}px`,
        'important'
      )
      button.setAttribute(
        'data-lumibionic-toolbar-spacing',
        String(spacing)
      )

      const item = toolbarItemForButton(button)
      if (!item) continue

      matched += 1

      const shouldHide =
        Boolean(settings.toolbarHidden?.[item.key])

      if (shouldHide) {
        button.setAttribute(
          'data-lumibionic-toolbar-hidden',
          item.key
        )
        button.style.setProperty(
          'display',
          'none',
          'important'
        )
        hidden += 1
      } else if (
        button.hasAttribute(
          'data-lumibionic-toolbar-hidden'
        )
      ) {
        button.style.removeProperty('display')
        button.removeAttribute(
          'data-lumibionic-toolbar-hidden'
        )
      }
    }

    const status =
      typeof tab !== 'undefined'
        ? tab.root?.querySelector(
            '#lb-toolbar-match-status'
          )
        : null

    if (status) {
      status.textContent =
        matched > 0
          ? `${matched} toolbar buttons detected · ${hidden} hidden`
          : 'No matching toolbar buttons detected on this screen'
    }
  }

  function clearToolbarVisibility() {
    document
      .querySelectorAll(
        '[data-lumibionic-toolbar-hidden], ' +
        '[data-lumibionic-toolbar-spacing]'
      )
      .forEach(button => {
        button.style.removeProperty('display')
        button.style.removeProperty('margin-inline')
        button.removeAttribute(
          'data-lumibionic-toolbar-hidden'
        )
        button.removeAttribute(
          'data-lumibionic-toolbar-spacing'
        )
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

    for (const item of TOOLBAR_BUTTONS) {
      root.classList.toggle(
        item.className,
        Boolean(settings.toolbarHidden?.[item.key])
      )
    }
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

    root.style.setProperty(
      '--lumibionic-reading-width',
      settings.readingWidth === 'full'
        ? 'none'
        : settings.readingWidth
    )

    root.style.setProperty(
      '--lumibionic-paragraph-spacing',
      `${settings.paragraphSpacing}em`
    )

    root.style.setProperty(
      '--lumibionic-letter-spacing',
      `${settings.letterSpacing}em`
    )

    root.style.setProperty(
      '--lumibionic-word-spacing',
      `${settings.wordSpacing}em`
    )

    root.style.setProperty(
      '--lumibionic-preview-letter-spacing',
      Math.abs(settings.letterSpacing) > 0.0001
        ? `${settings.letterSpacing}em`
        : 'normal'
    )

    root.style.setProperty(
      '--lumibionic-preview-word-spacing',
      Math.abs(settings.wordSpacing) > 0.0001
        ? `${settings.wordSpacing}em`
        : 'normal'
    )

    root.style.setProperty(
      '--lumibionic-preview-hyphens',
      settings.hyphenateMessages
        ? 'auto'
        : 'manual'
    )

    applyRootClasses()
    refreshBubbleScopes()
    applyToolbarVisibility()
  }

  function processAll() {
    if (rebuilding) return

    document
      .querySelectorAll(MESSAGE_SELECTOR)
      .forEach(processMessage)

    refreshBubbleScopes()
    applyToolbarVisibility()
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

  function updateSetting(key, value, rebuild = false, markCustom = true) {
    settings = {
      ...settings,
      [key]: value,
      ...(markCustom ? { preset: 'custom' } : {}),
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

  function updateToolbarSetting(key, hidden) {
    if (!TOOLBAR_BUTTONS.some(item => item.key === key)) return

    settings = {
      ...settings,
      toolbarHidden: {
        ...settings.toolbarHidden,
        [key]: Boolean(hidden),
      },
    }

    saveSettings()
    applyCssSettings()
    syncControls()
  }

  function setAllToolbarHidden(hidden) {
    settings = {
      ...settings,
      toolbarHidden: Object.fromEntries(
        TOOLBAR_BUTTONS.map(item => [item.key, Boolean(hidden)])
      ),
    }

    saveSettings()
    applyCssSettings()
    syncControls()
  }

  function applyPreset(name) {
    if (name === 'custom') {
      settings = { ...settings, preset: 'custom' }
      saveSettings()
      syncControls()
      return
    }

    const values = PRESETS[name]
    if (!values) return

    settings = {
      ...settings,
      ...values,
      preset: name,
    }

    saveSettings()
    applyCssSettings()
    syncControls()
    rebuildAll()
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
          Preset
        </div>

        <div class="lumibionic-control">
          <label for="lb-preset">Reading preset</label>
          <select id="lb-preset">
            <option value="custom">Custom</option>
            <option value="clean">Clean — minimal changes</option>
            <option value="comfortable">Comfortable — long-form</option>
            <option value="mobile">Mobile — touch-friendly reading</option>
            <option value="bionicLight">Bionic Light</option>
          </select>
          <div class="lumibionic-muted">
            Presets change reading controls but leave your font and font reach alone.
            Any manual adjustment switches back to Custom.
          </div>
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
          Long-form reading
        </div>

        <label class="lumibionic-check">
          <input id="lb-justify" type="checkbox">
          <span>Justify message prose</span>
        </label>

        <label class="lumibionic-check">
          <input id="lb-hyphens" type="checkbox">
          <span>Automatic hyphenation</span>
        </label>

        <div class="lumibionic-muted">
          Hyphenation depends on browser support and the
          language information available on the page.
        </div>

        <div class="lumibionic-control">
          <label for="lb-reading-width">Reading width</label>
          <select id="lb-reading-width"></select>
          <div class="lumibionic-muted">
            Limits long lines. “ch” is roughly one character wide.
          </div>
        </div>

        <div class="lumibionic-control">
          <div class="lumibionic-row">
            <label for="lb-paragraph-spacing">Paragraph spacing</label>
            <span class="lumibionic-value" id="lb-paragraph-spacing-value"></span>
          </div>
          <input id="lb-paragraph-spacing" type="range" min="0" max="1.5" step="0.1">
          <div class="lumibionic-muted">0 uses the theme default.</div>
        </div>

        <div class="lumibionic-control">
          <div class="lumibionic-row">
            <label for="lb-letter-spacing">Letter spacing</label>
            <span class="lumibionic-value" id="lb-letter-spacing-value"></span>
          </div>
          <input id="lb-letter-spacing" type="range" min="-0.03" max="0.12" step="0.005">
          <div class="lumibionic-muted">0 uses normal theme spacing.</div>
        </div>

        <div class="lumibionic-control">
          <div class="lumibionic-row">
            <label for="lb-word-spacing">Word spacing</label>
            <span class="lumibionic-value" id="lb-word-spacing-value"></span>
          </div>
          <input id="lb-word-spacing" type="range" min="-0.05" max="0.3" step="0.01">
          <div class="lumibionic-muted">Useful when justified text feels too cramped or airy.</div>
        </div>

      </div>

      <div class="lumibionic-section">

        <div class="lumibionic-section-title">
          Message typography
        </div>

        <div class="lumibionic-control">
          <div class="lumibionic-row">
            <label for="lb-size">Message text size</label>
            <span class="lumibionic-value" id="lb-size-value"></span>
          </div>
          <input id="lb-size" type="range" min="80" max="140" step="5">
        </div>

        <div class="lumibionic-control">
          <div class="lumibionic-row">
            <label for="lb-line">Message line spacing</label>
            <span class="lumibionic-value" id="lb-line-value"></span>
          </div>
          <input id="lb-line" type="range" min="1.1" max="2.2" step="0.05">
        </div>

      </div>

      <div class="lumibionic-section">

        <div class="lumibionic-section-title">
          FF think fix
        </div>

        <label class="lumibionic-check">
          <input id="lb-ff-think-fix" type="checkbox">
          <span>Move everything before the RP boundary into native reasoning</span>
        </label>

        <div class="lumibionic-muted">
          After the AI finishes, the extension edits the saved assistant
          message using Lumiverse's native reasoning field. Everything before
          the first boundary marker becomes the collapsible reasoning block;
          the boundary and the RP after it remain normal message content.
        </div>

        <div class="lumibionic-control">
          <label for="lb-ff-boundary-text">RP boundary marker</label>
          <input
            id="lb-ff-boundary-text"
            type="text"
            spellcheck="false"
          >
        </div>

        <div class="lumibionic-toolbar-actions">
          <button type="button" id="lb-ff-run-now">
            ▶ Run FF think fix now
          </button>
          <button type="button" id="lb-ff-reset-pattern">
            Reset boundary marker
          </button>
        </div>

        <div class="lumibionic-muted">
          Manual run ignores the automatic toggle and repairs the latest
          assistant message in the currently open chat. Default boundary:
          <code>[ 🕰️ Time</code>. The fix uses Lumiverse's native
          reasoning field instead of inserting
          <code>&lt;think&gt;</code> tags.
        </div>

        <div class="lumibionic-muted" id="lb-ff-backend-status">
          FF backend: checking…
        </div>

        <div class="lumibionic-muted" id="lb-ff-think-status">
          Waiting for the next completed AI reply.
        </div>

      </div>

      <div class="lumibionic-section">

        <div class="lumibionic-section-title">
          Chat toolbar
        </div>

        <div class="lumibionic-muted">
          Tap an item to hide or show that exact Lumiverse toolbar button.
          These use the same title matches as your CSS block.
        </div>

        <div class="lumibionic-control">
          <div class="lumibionic-row">
            <label for="lb-toolbar-spacing">Toolbar button gap</label>
            <span class="lumibionic-value" id="lb-toolbar-spacing-value"></span>
          </div>
          <input
            id="lb-toolbar-spacing"
            type="range"
            min="0"
            max="16"
            step="1"
          >
          <div class="lumibionic-muted">
            Total space between neighboring toolbar buttons. 0px packs them together.
          </div>
        </div>

<div class="lumibionic-toolbar-grid" id="lb-toolbar-grid"></div>

        <div class="lumibionic-toolbar-actions">
          <button type="button" id="lb-toolbar-hide-all">Hide all listed</button>
          <button type="button" id="lb-toolbar-show-all">Show all listed</button>
        </div>

        <div class="lumibionic-muted" id="lb-toolbar-match-status">
          Checking Lumiverse toolbar…
        </div>

        <div class="lumibionic-muted">
          If the old custom CSS block is still active elsewhere, remove it first;
          otherwise it will keep these buttons hidden regardless of this setting.
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

  const preset = $('#lb-preset')
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
  const hyphens = $('#lb-hyphens')
  const readingWidth = $('#lb-reading-width')
  const paragraphSpacing = $('#lb-paragraph-spacing')
  const paragraphSpacingValue = $('#lb-paragraph-spacing-value')
  const letterSpacing = $('#lb-letter-spacing')
  const letterSpacingValue = $('#lb-letter-spacing-value')
  const wordSpacing = $('#lb-word-spacing')
  const wordSpacingValue = $('#lb-word-spacing-value')
  const size = $('#lb-size')
  const sizeValue = $('#lb-size-value')
  const line = $('#lb-line')
  const lineValue = $('#lb-line-value')

  const ffThinkFix = $('#lb-ff-think-fix')
  const ffThinkBoundaryText = $('#lb-ff-boundary-text')
  const ffThinkRunNow = $('#lb-ff-run-now')
  const ffThinkResetPattern = $('#lb-ff-reset-pattern')
  const ffThinkBackendStatus = $('#lb-ff-backend-status')
  const ffThinkStatus = $('#lb-ff-think-status')

  const preview = $('#lb-preview')
  const reset = $('#lb-reset')

  const toolbarSpacing = $('#lb-toolbar-spacing')
  const toolbarSpacingValue = $('#lb-toolbar-spacing-value')
  const toolbarGrid = $('#lb-toolbar-grid')
  const toolbarHideAll = $('#lb-toolbar-hide-all')
  const toolbarShowAll = $('#lb-toolbar-show-all')

  if (toolbarGrid) {
    toolbarGrid.replaceChildren()

    for (const item of TOOLBAR_BUTTONS) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'lumibionic-toolbar-toggle'
      button.dataset.toolbarKey = item.key

      const label = document.createElement('span')
      label.textContent = item.label

      const state = document.createElement('small')
      state.textContent = 'Shown'

      button.append(label, state)
      toolbarGrid.appendChild(button)
    }
  }

  const toolbarToggleButtons = Array.from(
    tab.root.querySelectorAll('[data-toolbar-key]')
  )

  for (const [value, label] of FONT_OPTIONS) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    font.appendChild(option)
  }

  for (const [value, label] of WIDTH_OPTIONS) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    readingWidth.appendChild(option)
  }

  function loadUiState() {
    try {
      const saved = JSON.parse(localStorage.getItem(UI_STATE_KEY) || '{}')
      return {
        previewVisible:
          typeof saved.previewVisible === 'boolean'
            ? saved.previewVisible
            : false,
        sections:
          saved.sections && typeof saved.sections === 'object'
            ? saved.sections
            : {},
      }
    } catch {
      return { previewVisible: false, sections: {} }
    }
  }

  let uiState = loadUiState()

  function saveUiState() {
    try {
      localStorage.setItem(UI_STATE_KEY, JSON.stringify(uiState))
    } catch {}
  }

  function sectionKey(title) {
    return title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
  }

  function setupCollapsibleUi() {
    const settingsRoot = tab.root.querySelector('.lumibionic-settings')
    if (!settingsRoot) return

    const previewSection = preview.closest('.lumibionic-section')
    const headingBlock = settingsRoot.firstElementChild

    if (previewSection && headingBlock) {
      previewSection.classList.add('lumibionic-preview-section')
      headingBlock.insertAdjacentElement('afterend', previewSection)

      const toolbar = document.createElement('div')
      toolbar.className = 'lumibionic-preview-toolbar'
      toolbar.innerHTML = `
        <strong>Live preview</strong>
        <button type="button" id="lb-toggle-preview"></button>
      `
      previewSection.insertBefore(toolbar, previewSection.firstChild)

      const previewControl = preview.closest('.lumibionic-control')
      const previewLabel = previewControl?.querySelector('label')
      if (previewLabel) previewLabel.remove()

      const previewToggle = toolbar.querySelector('#lb-toggle-preview')

      const syncPreviewVisibility = () => {
        if (previewControl) {
          previewControl.classList.toggle(
            'lumibionic-hidden',
            !uiState.previewVisible
          )
        }
        if (previewToggle) {
          previewToggle.textContent = uiState.previewVisible
            ? 'Hide preview'
            : 'Show preview'
          previewToggle.setAttribute(
            'aria-expanded',
            String(uiState.previewVisible)
          )
        }
      }

      previewToggle?.addEventListener('click', () => {
        uiState = {
          ...uiState,
          previewVisible: !uiState.previewVisible,
        }
        saveUiState()
        syncPreviewVisibility()
      })

      syncPreviewVisibility()
    }

    const uiActions = document.createElement('div')
    uiActions.className = 'lumibionic-ui-actions'
    uiActions.innerHTML = `
      <button type="button" id="lb-collapse-all">Collapse settings</button>
      <button type="button" id="lb-expand-all">Expand settings</button>
    `

    if (previewSection) {
      previewSection.insertAdjacentElement('afterend', uiActions)
    } else if (headingBlock) {
      headingBlock.insertAdjacentElement('afterend', uiActions)
    }

    const sectionControllers = []

    tab.root
      .querySelectorAll('.lumibionic-section')
      .forEach(section => {
        if (section.classList.contains('lumibionic-preview-section')) return

        const title = section.querySelector(':scope > .lumibionic-section-title')
        if (!title) return

        const key = sectionKey(title.textContent || 'section')
        const body = document.createElement('div')
        body.className = 'lumibionic-section-body'

        const children = Array.from(section.children)
        for (const child of children) {
          if (child !== title) body.appendChild(child)
        }

        const toggle = document.createElement('button')
        toggle.type = 'button'
        toggle.className = 'lumibionic-section-toggle'
        toggle.textContent = title.textContent.trim()

        title.replaceWith(toggle)
        section.appendChild(body)

        const savedExpanded = uiState.sections[key]
        const initialExpanded =
          typeof savedExpanded === 'boolean'
            ? savedExpanded
            : false

        const setExpanded = (expanded, persist = true) => {
          body.classList.toggle(
            'lumibionic-section-collapsed',
            !expanded
          )
          toggle.setAttribute('aria-expanded', String(expanded))

          if (persist) {
            uiState = {
              ...uiState,
              sections: {
                ...uiState.sections,
                [key]: expanded,
              },
            }
            saveUiState()
          }
        }

        toggle.addEventListener('click', () => {
          setExpanded(toggle.getAttribute('aria-expanded') !== 'true')
        })

        setExpanded(initialExpanded, false)
        sectionControllers.push(setExpanded)
      })

    uiActions
      .querySelector('#lb-collapse-all')
      ?.addEventListener('click', () => {
        for (const setExpanded of sectionControllers) setExpanded(false)
      })

    uiActions
      .querySelector('#lb-expand-all')
      ?.addEventListener('click', () => {
        for (const setExpanded of sectionControllers) setExpanded(true)
      })
  }

  setupCollapsibleUi()

  function formatEm(value, digits = 2) {
    if (Math.abs(value) < 0.0001) return 'Theme'
    return `${Number(value).toFixed(digits)}em`
  }

  function syncControls() {
    preset.value = settings.preset || 'custom'
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
    hyphens.checked = settings.hyphenateMessages
    readingWidth.value = settings.readingWidth

    paragraphSpacing.value = String(settings.paragraphSpacing)
    paragraphSpacingValue.textContent = formatEm(settings.paragraphSpacing, 1)

    letterSpacing.value = String(settings.letterSpacing)
    letterSpacingValue.textContent = formatEm(settings.letterSpacing, 3)

    wordSpacing.value = String(settings.wordSpacing)
    wordSpacingValue.textContent = formatEm(settings.wordSpacing, 2)

    size.value = String(settings.textSize)
    sizeValue.textContent = `${settings.textSize}%`

    line.value = String(settings.lineHeight)
    lineValue.textContent = settings.lineHeight.toFixed(2)

    ffThinkFix.checked = settings.ffThinkFixEnabled
    ffThinkBoundaryText.value = settings.ffThinkBoundaryText

    toolbarSpacing.value = String(settings.toolbarSpacing)
    toolbarSpacingValue.textContent = `${settings.toolbarSpacing}px`

    for (const button of toolbarToggleButtons) {
      const key = button.dataset.toolbarKey
      const hidden = Boolean(settings.toolbarHidden?.[key])
      button.dataset.hidden = String(hidden)
      button.setAttribute('aria-pressed', String(hidden))

      const state = button.querySelector('small')
      if (state) state.textContent = hidden ? 'Hidden' : 'Shown'
    }

    for (const sync of mobileStepperSyncers) sync()
  }

  const mobileStepperSyncers = []

  function createMobileStepper(range, key, { rebuild = false, resetValue = DEFAULTS[key] } = {}) {
    if (!range) return

    range.classList.add('lumibionic-mobile-safe-range')

    const min = Number(range.min)
    const max = Number(range.max)
    const step = Number(range.step) || 1
    const stepText = String(range.step || '1')
    const decimals = stepText.includes('.') ? stepText.split('.')[1].length : 0

    const wrap = document.createElement('div')
    wrap.className = 'lumibionic-stepper'

    const minus = document.createElement('button')
    minus.type = 'button'
    minus.textContent = '−'
    minus.setAttribute('aria-label', `Decrease ${key}`)

    const exact = document.createElement('input')
    exact.type = 'number'
    exact.inputMode = 'decimal'
    exact.min = String(min)
    exact.max = String(max)
    exact.step = String(step)
    exact.setAttribute('aria-label', `Exact ${key} value`)

    const plus = document.createElement('button')
    plus.type = 'button'
    plus.textContent = '+'
    plus.setAttribute('aria-label', `Increase ${key}`)

    const resetOne = document.createElement('button')
    resetOne.type = 'button'
    resetOne.textContent = '↶'
    resetOne.className = 'lumibionic-stepper-reset'
    resetOne.setAttribute('aria-label', `Reset ${key}`)

    wrap.append(minus, exact, plus, resetOne)
    range.insertAdjacentElement('afterend', wrap)

    function normalized(raw) {
      let value = Number(raw)
      if (!Number.isFinite(value)) value = Number(settings[key])
      value = Math.min(max, Math.max(min, value))
      value = min + Math.round((value - min) / step) * step
      return Number(value.toFixed(decimals))
    }

    function commit(raw) {
      const value = normalized(raw)
      exact.value = String(value)
      updateSetting(key, value, rebuild)
    }

    minus.addEventListener('click', () => commit(Number(settings[key]) - step))
    plus.addEventListener('click', () => commit(Number(settings[key]) + step))
    exact.addEventListener('change', () => commit(exact.value))
    exact.addEventListener('keydown', event => {
      if (event.key === 'Enter') exact.blur()
    })
    resetOne.addEventListener('click', () => commit(resetValue))

    mobileStepperSyncers.push(() => {
      exact.value = String(settings[key])
    })
  }

  createMobileStepper(fixation, 'fixation', { rebuild: true, resetValue: DEFAULTS.fixation })
  createMobileStepper(weight, 'weight', { resetValue: DEFAULTS.weight })
  createMobileStepper(paragraphSpacing, 'paragraphSpacing', { resetValue: DEFAULTS.paragraphSpacing })
  createMobileStepper(letterSpacing, 'letterSpacing', { resetValue: DEFAULTS.letterSpacing })
  createMobileStepper(wordSpacing, 'wordSpacing', { resetValue: DEFAULTS.wordSpacing })
  createMobileStepper(size, 'textSize', { resetValue: DEFAULTS.textSize })
  createMobileStepper(line, 'lineHeight', { resetValue: DEFAULTS.lineHeight })
  createMobileStepper(toolbarSpacing, 'toolbarSpacing', { resetValue: DEFAULTS.toolbarSpacing })

  function renderPreview() {
    preview.replaceChildren()

    preview.classList.toggle(
      'lb-preview-justify',
      settings.justifyMessages
    )

    preview.style.maxWidth =
      settings.readingWidth === 'full'
        ? ''
        : settings.readingWidth

    const samples = [
      'A dry chuckle escaped him as he leaned toward the doorway. This line is long enough to judge justification and word spacing.',
      'She glanced toward the rain-dark window. Adjust paragraph spacing to see this second paragraph move closer or farther away.'
    ]

    for (const sampleText of samples) {
      const paragraph = document.createElement('p')
      const sample = document.createTextNode(sampleText)

      paragraph.appendChild(sample)
      preview.appendChild(paragraph)

      if (settings.bionicEnabled) {
        processTextNode(sample)
      }
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

  toolbarGrid?.addEventListener('click', event => {
    const button = event.target.closest('[data-toolbar-key]')
    if (!button || !toolbarGrid.contains(button)) return

    const key = button.dataset.toolbarKey
    updateToolbarSetting(
      key,
      !Boolean(settings.toolbarHidden?.[key])
    )
  })

  toolbarHideAll?.addEventListener(
    'click',
    () => setAllToolbarHidden(true)
  )

  toolbarShowAll?.addEventListener(
    'click',
    () => setAllToolbarHidden(false)
  )

  preset.addEventListener(
    'change',
    () => applyPreset(preset.value)
  )

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

  hyphens.addEventListener(
    'change',
    () => updateSetting(
      'hyphenateMessages',
      hyphens.checked
    )
  )

  readingWidth.addEventListener(
    'change',
    () => updateSetting(
      'readingWidth',
      readingWidth.value
    )
  )

  paragraphSpacing.addEventListener(
    'input',
    () => updateSetting(
      'paragraphSpacing',
      Number(paragraphSpacing.value)
    )
  )

  letterSpacing.addEventListener(
    'input',
    () => updateSetting(
      'letterSpacing',
      Number(letterSpacing.value)
    )
  )

  wordSpacing.addEventListener(
    'input',
    () => updateSetting(
      'wordSpacing',
      Number(wordSpacing.value)
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

  function syncFFThinkBackendConfig() {
    ctx.sendToBackend({
      type: 'ff_think_fix_config',
      enabled: Boolean(settings.ffThinkFixEnabled),
      config: {
        boundaryText: settings.ffThinkBoundaryText,
      },
    })
  }

  let ffManualRequestId = null
  let ffManualTimeout = null

  function finishFFManualRequest() {
    if (ffManualTimeout) {
      clearTimeout(ffManualTimeout)
      ffManualTimeout = null
    }

    ffManualRequestId = null

    if (ffThinkRunNow) {
      ffThinkRunNow.disabled = false
    }
  }

  ffThinkFix.addEventListener(
    'change',
    () => {
      updateSetting(
        'ffThinkFixEnabled',
        ffThinkFix.checked,
        false,
        false
      )

      syncFFThinkBackendConfig()

      if (ffThinkStatus) {
        ffThinkStatus.textContent =
          ffThinkFix.checked
            ? 'Enabled — backend auto-fix is armed for the next completed AI reply.'
            : 'Automatic fix disabled. Manual ▶ still works.'
      }
    }
  )

  const ffTextBindings = [
    [ffThinkBoundaryText, 'ffThinkBoundaryText'],
  ]

  for (const [input, key] of ffTextBindings) {
    input.addEventListener('input', () => {
      settings = {
        ...settings,
        [key]: input.value,
      }
      saveSettings()
      syncFFThinkBackendConfig()
    })
  }

  ffThinkResetPattern.addEventListener(
    'click',
    () => {
      settings = {
        ...settings,
        ffThinkBoundaryText: DEFAULTS.ffThinkBoundaryText,
      }

      saveSettings()
      syncControls()
      syncFFThinkBackendConfig()

      if (ffThinkStatus) {
        ffThinkStatus.textContent =
          'FF think fix boundary reset to default.'
      }
    }
  )

  ffThinkRunNow.addEventListener(
    'click',
    () => {
      let chatId = null
      let latestMessageId = null

      try {
        const active =
          ctx.getActiveChat()

        chatId =
          typeof active?.chatId === 'string'
            ? active.chatId
            : null

        latestMessageId =
          ctx.messages?.getLatestMessageId?.() || null
      } catch {
        chatId = null
        latestMessageId = null
      }

      if (!chatId) {
        if (ffThinkStatus) {
          ffThinkStatus.textContent =
            'Manual FF fix could not detect the current chat.'
        }
        return
      }

      const requestId =
        `manual:${Date.now()}:${
          Math.random()
            .toString(36)
            .slice(2, 9)
        }`

      ffManualRequestId = requestId
      ffThinkRunNow.disabled = true

      if (ffThinkStatus) {
        ffThinkStatus.textContent =
          latestMessageId
            ? `▶ Current chat found. Latest logical message: ${latestMessageId.slice(0, 8)}… Asking backend for the latest assistant.`
            : '▶ Current chat found. Asking backend for the latest assistant.'
      }

      try {
        ctx.sendToBackend({
          type: 'ff_think_fix_manual',
          requestId,
          chatId,
          latestMessageId,
          config: {
            boundaryText: settings.ffThinkBoundaryText,
          },
        })
      } catch (error) {
        finishFFManualRequest()

        if (ffThinkStatus) {
          ffThinkStatus.textContent =
            `Manual FF fix could not contact the backend: ${
              error?.message || 'unknown error'
            }`
        }
        return
      }

      ffManualTimeout =
        setTimeout(() => {
          if (
            ffManualRequestId !== requestId
          ) {
            return
          }

          finishFFManualRequest()

          if (ffThinkStatus) {
            ffThinkStatus.textContent =
              'Manual FF fix timed out: the backend did not answer within 9 seconds. If the FF backend line still says checking, the backend bundle is not running.'
          }
        }, 9000)
    }
  )

  toolbarSpacing.addEventListener(
    'input',
    () => updateSetting(
      'toolbarSpacing',
      Number(toolbarSpacing.value)
    )
  )

  reset.addEventListener(
    'click',
    () => {
      unloadLocalFont(false)

      settings = {
        ...DEFAULTS,
        toolbarHidden: { ...DEFAULT_TOOLBAR_HIDDEN },
      }

      saveSettings()
      applyCssSettings()
      syncControls()
      rebuildAll()
      renderPreview()
    }
  )

  // Automatic FF fixing is handled by the backend GENERATION_ENDED listener.
  // Sync the saved user choice/config as soon as the frontend loads.
  syncFFThinkBackendConfig()

  const unsubBackendMessage =
    ctx.onBackendMessage(payload => {
      if (
        payload?.type ===
        'ff_think_fix_health'
      ) {
        if (ffThinkBackendStatus) {
          ffThinkBackendStatus.textContent =
            `FF backend: connected v${
              payload.version || '?'
            }`
        }
        return
      }

      if (
        payload?.type ===
        'ff_think_fix_progress'
      ) {
        if (
          payload.source === 'manual' &&
          ffManualRequestId &&
          payload.requestId === ffManualRequestId
        ) {
          if (ffThinkStatus) {
            ffThinkStatus.textContent =
              payload.stage === 'reading'
                ? `▶ Backend v${payload.version || '?'} received the request — reading saved chat messages…`
                : `▶ Backend v${payload.version || '?'} found the assistant — applying native reasoning update…`
          }
        }
        return
      }

      if (
        payload?.type !==
        'ff_think_fix_result'
      ) {
        return
      }

      if (
        payload.source === 'manual' &&
        ffManualRequestId &&
        payload.requestId === ffManualRequestId
      ) {
        finishFFManualRequest()
      }

      if (!ffThinkStatus) return

      const sourceLabel =
        payload.source === 'manual'
          ? 'Manual'
          : 'Automatic'

      if (payload.status === 'fixed') {
        ffThinkStatus.textContent =
          `${sourceLabel} FF fix succeeded — moved pre-boundary text into native reasoning.`
      } else if (payload.status === 'no_match') {
        ffThinkStatus.textContent =
          `${sourceLabel} FF fix: no matching RP boundary marker in the target reply.`
      } else if (payload.status === 'already_fixed') {
        ffThinkStatus.textContent =
          `${sourceLabel} FF fix: target reply is already split into native reasoning.`
      } else if (payload.status === 'no_assistant') {
        ffThinkStatus.textContent =
          'Manual FF fix: no assistant message was found in this chat.'
      } else if (payload.status === 'not_assistant') {
        ffThinkStatus.textContent =
          'Automatic FF fix skipped: generated target was not an assistant reply.'
      } else if (payload.status === 'busy') {
        ffThinkStatus.textContent =
          `${sourceLabel} FF fix: that message is already being repaired.`
      } else if (payload.status === 'error') {
        ffThinkStatus.textContent =
          `${sourceLabel} FF fix failed: ${payload.error || 'unknown error'}`
      }
    })

  /*
    Ask the backend to identify itself after the receiver is installed.
    If an old backend is still running, this line stays on "checking…",
    which makes a stale hot-reload obvious.
  */
  try {
    ctx.sendToBackend({
      type: 'ff_think_fix_health',
    })
  } catch {
    if (ffThinkBackendStatus) {
      ffThinkBackendStatus.textContent =
        'FF backend: frontend could not send a health check.'
    }
  }

  /*
    Explicitly release any backend->frontend startup messages instead of
    relying on legacy auto-ready timing.
  */
  try {
    ctx.ready?.()
  } catch {}

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
      attributes: true,
      attributeFilter: [
        'title',
        'aria-label',
        'data-tooltip',
        'data-title'
      ],
    }
  )

  applyCssSettings()
  syncControls()
  renderPreview()
  processAll()

  return () => {
    observer.disconnect()
    unsubBackendMessage?.()

    unwrap()
    unloadLocalFont(false)
    clearToolbarVisibility()

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
      ...TOOLBAR_BUTTONS.map(item => item.className),
    ]) {
      root.classList.remove(className)
    }

    for (const property of [
      '--lumibionic-weight',
      '--lumibionic-font-family',
      '--lumibionic-preview-font',
      '--lumibionic-text-size',
      '--lumibionic-line-height',
      '--lumibionic-reading-width',
      '--lumibionic-paragraph-spacing',
      '--lumibionic-letter-spacing',
      '--lumibionic-word-spacing',
      '--lumibionic-preview-letter-spacing',
      '--lumibionic-preview-word-spacing',
      '--lumibionic-preview-hyphens',
    ]) {
      root.style.removeProperty(property)
    }

    tab.destroy()
    removeStyle()
    ctx.dom.cleanup()
  }
}
