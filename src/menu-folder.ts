const MENU_FOLDER_STORAGE_KEY =
  'lumiverse:bionic-style-reading:menu-folder:v1'

const MENU_FOLDER_PERMISSION =
  'app_manipulation'

const MENU_FOLDER_CONTAINER_PREFIX =
  'bionic-menu-folder'

const MENU_FOLDER_TARGETS = [
  ['profile', 'Profile'],
  ['presets', 'Reasoning'],
  ['loom', 'Loom'],
  ['characters', 'Characters'],
  ['personas', 'Personas'],
  ['branches', 'Branches'],
  ['spindle', 'Extensions'],
  ['theme', 'Theme'],
  ['lorebook', 'Lorebook'],
] as const

const MENU_FOLDER_ICON_SVG = `
<svg
  xmlns="http://www.w3.org/2000/svg"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H9l2 2h7.5A2.5 2.5 0 0 1 21 8.5v8A3.5 3.5 0 0 1 17.5 20h-11A3.5 3.5 0 0 1 3 16.5z"/>
</svg>
`

type MenuLocation =
  | {
      kind: 'main-drawer'
    }
  | {
      kind: 'container'
      containerId: string
    }

function containerIdFor(
  tabId: string
) {
  return `${MENU_FOLDER_CONTAINER_PREFIX}:${tabId}`
}

function validIds() {
  return new Set(
    MENU_FOLDER_TARGETS.map(
      ([id]) => id
    )
  )
}

function loadSelection() {
  try {
    const parsed =
      JSON.parse(
        localStorage.getItem(
          MENU_FOLDER_STORAGE_KEY
        ) || '[]'
      )

    if (!Array.isArray(parsed)) {
      return []
    }

    const allowed = validIds()

    return parsed.filter(
      (id): id is string =>
        typeof id === 'string' &&
        allowed.has(id as any)
    )
  } catch {
    return []
  }
}

function saveSelection(
  ids: Iterable<string>
) {
  try {
    localStorage.setItem(
      MENU_FOLDER_STORAGE_KEY,
      JSON.stringify(
        Array.from(ids)
      )
    )
  } catch {}
}

function grantedPermissionNames(
  value: any
): string[] {
  if (Array.isArray(value)) {
    return value.filter(
      item =>
        typeof item === 'string'
    )
  }

  if (
    Array.isArray(
      value?.granted
    )
  ) {
    return value.granted.filter(
      (item: any) =>
        typeof item === 'string'
    )
  }

  if (
    Array.isArray(
      value?.permissions
    )
  ) {
    return value.permissions.filter(
      (item: any) =>
        typeof item === 'string'
    )
  }

  return []
}

export function installMenuFolder(
  ctx: any,
  settingsRoot: HTMLElement
) {
  let selected =
    new Set<string>(
      loadSelection()
    )

  let draft =
    new Set<string>(
      selected
    )

  let placed =
    new Set<string>()

  let activeId =
    MENU_FOLDER_TARGETS.find(
      ([id]) =>
        selected.has(id)
    )?.[0] || ''

  let destroyed = false

  const originalLocations =
    new Map<
      string,
      MenuLocation
    >()

  const removeStyle =
    ctx.dom.addStyle(`
      .lb-menu-folder-shell {
        display: flex;
        flex-direction: column;
        min-height: 100%;
      }

      .lb-menu-folder-nav {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        padding: 8px 10px 10px;
        border-bottom: 1px solid
          var(--lumiverse-border, rgba(127,127,127,.22));
      }

      .lb-menu-folder-nav button {
        min-height: 30px;
        padding: 5px 10px;
        border-radius: 8px;
      }

      .lb-menu-folder-nav button[data-active="true"] {
        background:
          color-mix(
            in srgb,
            var(--lumiverse-accent, #8b5cf6) 18%,
            transparent
          );
        border-color:
          var(--lumiverse-accent, #8b5cf6);
      }

      .lb-menu-folder-empty {
        padding: 18px 12px;
        opacity: .72;
        line-height: 1.45;
      }

      .lb-menu-folder-panes {
        min-height: 0;
        flex: 1;
      }

      .lb-menu-folder-pane {
        min-height: 100%;
      }

      .lb-menu-folder-pane[hidden] {
        display: none !important;
      }

      .lb-menu-folder-grid {
        display: grid;
        grid-template-columns:
          repeat(
            auto-fit,
            minmax(150px, 1fr)
          );
        gap: 7px 12px;
        margin-top: 10px;
      }

      .lb-menu-folder-grid label {
        display: flex;
        align-items: center;
        gap: 7px;
      }
    `)

  const folderTab =
    ctx.ui.registerDrawerTab({
      id: 'bionic-menu-folder',
      title: 'Menu Folder',
      shortName: 'Folder',
      headerTitle: 'Menu Folder',
      description:
        'Keep selected Lumiverse drawer tools inside one compact folder',
      keywords: [
        'folder',
        'menu',
        'drawer',
        'organize',
        'hide',
        'tabs',
      ],
      iconSvg:
        MENU_FOLDER_ICON_SVG,
    })

  folderTab.root.innerHTML = `
    <div class="lb-menu-folder-shell">
      <div
        class="lb-menu-folder-nav"
        data-lb-menu-folder-nav
      ></div>

      <div
        class="lb-menu-folder-empty"
        data-lb-menu-folder-empty
      >
        Choose menu items in
        Reading & Fonts → Menu Folder.
      </div>

      <div
        class="lb-menu-folder-panes"
        data-lb-menu-folder-panes
      ></div>
    </div>
  `

  const nav =
    folderTab.root.querySelector(
      '[data-lb-menu-folder-nav]'
    ) as HTMLElement

  const empty =
    folderTab.root.querySelector(
      '[data-lb-menu-folder-empty]'
    ) as HTMLElement

  const panesHost =
    folderTab.root.querySelector(
      '[data-lb-menu-folder-panes]'
    ) as HTMLElement

  const panes =
    new Map<
      string,
      HTMLElement
    >()

  for (
    const [id] of
      MENU_FOLDER_TARGETS
  ) {
    const pane =
      document.createElement(
        'div'
      )

    pane.className =
      'lb-menu-folder-pane'

    pane.dataset.menuFolderPane =
      id

    pane.hidden = true

    panesHost.appendChild(pane)

    panes.set(id, pane)

    ctx.containers.registerContainer({
      id: containerIdFor(id),
      side: 'left',
      element: pane,
    })
  }

  function targetLabel(
    id: string
  ) {
    return (
      MENU_FOLDER_TARGETS.find(
        ([targetId]) =>
          targetId === id
      )?.[1] ||
      id
    )
  }

  function renderFolder() {
    if (destroyed) return

    const visible =
      MENU_FOLDER_TARGETS.filter(
        ([id]) =>
          selected.has(id)
      )

    if (
      activeId &&
      !selected.has(activeId)
    ) {
      activeId = ''
    }

    if (
      !activeId &&
      visible.length
    ) {
      activeId =
        visible[0][0]
    }

    nav.replaceChildren()

    for (
      const [id, label] of
        visible
    ) {
      const button =
        document.createElement(
          'button'
        )

      button.type = 'button'
      button.textContent = label

      button.dataset.active =
        String(id === activeId)

      button.addEventListener(
        'click',
        () => {
          activeId = id
          renderFolder()
        }
      )

      nav.appendChild(button)
    }

    empty.hidden =
      visible.length > 0

    for (
      const [id, pane] of
        panes
    ) {
      pane.hidden =
        !selected.has(id) ||
        id !== activeId
    }

    folderTab.setBadge(
      visible.length
        ? String(
            visible.length
          )
        : null
    )
  }

  const settingsSection =
    document.createElement(
      'details'
    )

  settingsSection.className =
    'lumibionic-group'

  settingsSection.dataset
    .lumibionicGroup =
    'Menu Folder'

  settingsSection.innerHTML = `
    <summary>
      Menu Folder
    </summary>

    <div class="lumibionic-group-body">
      <div class="lumibionic-section">
        <div class="lumibionic-section-title">
          Organize the left menu
        </div>

        <div class="lumibionic-muted">
          Move supported Lumiverse drawer items into one
          Folder icon. Their native panels are preserved;
          Bionic only changes where Lumiverse mounts them.
        </div>

        <div class="lb-menu-folder-grid">
          ${MENU_FOLDER_TARGETS.map(
            ([id, label]) => `
              <label>
                <input
                  type="checkbox"
                  data-lb-menu-folder-choice="${id}"
                  ${
                    draft.has(id)
                      ? 'checked'
                      : ''
                  }
                >
                <span>${label}</span>
              </label>
            `
          ).join('')}
        </div>

        <div
          class="lumibionic-toolbar-actions"
          style="margin-top:12px"
        >
          <button
            type="button"
            data-lb-menu-folder-apply
          >
            Apply menu folder
          </button>

          <button
            type="button"
            data-lb-menu-folder-clear
          >
            Clear folder
          </button>

          <button
            type="button"
            data-lb-menu-folder-open
          >
            Open Folder
          </button>
        </div>

        <div
          class="lumibionic-muted"
          data-lb-menu-folder-status
          style="margin-top:8px"
        ></div>

        <div
          class="lumibionic-muted"
          style="margin-top:8px"
        >
          Lumiverse currently permits extensions to relocate:
          Profile, Reasoning, Loom, Characters, Personas,
          Branches, Extensions, Theme, and Lorebook.
        </div>
      </div>
    </div>
  `

  const settingsHost =
    settingsRoot.querySelector(
      '.lumibionic-settings'
    ) ||
    settingsRoot

  settingsHost.appendChild(
    settingsSection
  )

  const status =
    settingsSection.querySelector(
      '[data-lb-menu-folder-status]'
    ) as HTMLElement

  const applyButton =
    settingsSection.querySelector(
      '[data-lb-menu-folder-apply]'
    ) as HTMLButtonElement

  const clearButton =
    settingsSection.querySelector(
      '[data-lb-menu-folder-clear]'
    ) as HTMLButtonElement

  const openButton =
    settingsSection.querySelector(
      '[data-lb-menu-folder-open]'
    ) as HTMLButtonElement

  function setStatus(
    message: string
  ) {
    status.textContent =
      message
  }

  function syncDraftFromInputs() {
    draft.clear()

    settingsSection
      .querySelectorAll(
        '[data-lb-menu-folder-choice]'
      )
      .forEach(node => {
        const input =
          node as HTMLInputElement

        const id =
          input.dataset
            .lbMenuFolderChoice ||
          ''

        if (
          id &&
          input.checked
        ) {
          draft.add(id)
        }
      })
  }

  function syncInputs() {
    settingsSection
      .querySelectorAll(
        '[data-lb-menu-folder-choice]'
      )
      .forEach(node => {
        const input =
          node as HTMLInputElement

        const id =
          input.dataset
            .lbMenuFolderChoice ||
          ''

        input.checked =
          draft.has(id)
      })
  }

  async function hasMobilityPermission() {
    try {
      const value =
        await Promise.resolve(
          ctx.permissions
            ?.getGranted?.()
        )

      const granted =
        grantedPermissionNames(
          value
        )

      return granted.includes(
        'app_manipulation'
      )
    } catch {
      return false
    }
  }

  async function ensureMobilityPermission(
    request: boolean
  ) {
    if (
      await hasMobilityPermission()
    ) {
      return true
    }

    if (!request) {
      return false
    }

    try {
      await Promise.resolve(
        ctx.permissions
          ?.request?.([
            MENU_FOLDER_PERMISSION,
          ])
      )
    } catch {}

    return (
      await hasMobilityPermission()
    )
  }

  function safeCurrentLocation(
    id: string
  ): MenuLocation {
    try {
      const current =
        ctx.ui.getTabLocation?.(
          id
        )

      if (
        current?.kind ===
          'container' &&
        typeof current
          .containerId ===
          'string'
      ) {
        if (
          current.containerId
            .startsWith(
              `${MENU_FOLDER_CONTAINER_PREFIX}:`
            )
        ) {
          return {
            kind:
              'main-drawer',
          }
        }

        return {
          kind:
            'container',
          containerId:
            current.containerId,
        }
      }
    } catch {}

    return {
      kind: 'main-drawer',
    }
  }

  async function applyDraft(
    requestPermission: boolean
  ) {
    syncDraftFromInputs()

    const desired =
      new Set(draft)

    const needsMovement =
      desired.size > 0 ||
      placed.size > 0

    if (needsMovement) {
      const allowed =
        await ensureMobilityPermission(
          requestPermission
        )

      if (!allowed) {
        setStatus(
          'Menu Folder needs Lumiverse’s App Manipulation permission before it can move drawer tabs.'
        )

        return
      }
    }

    applyButton.disabled = true
    clearButton.disabled = true

    try {
      for (
        const id of
          Array.from(placed)
      ) {
        if (
          desired.has(id)
        ) {
          continue
        }

        const original =
          originalLocations.get(id) ||
          {
            kind:
              'main-drawer',
          }

        ctx.ui.requestTabLocation(
          id,
          original
        )

        placed.delete(id)
        originalLocations.delete(
          id
        )
      }

      for (
        const id of desired
      ) {
        if (
          placed.has(id)
        ) {
          continue
        }

        if (
          !originalLocations.has(
            id
          )
        ) {
          originalLocations.set(
            id,
            safeCurrentLocation(
              id
            )
          )
        }

        ctx.ui.requestTabLocation(
          id,
          {
            kind: 'container',
            containerId:
              containerIdFor(id),
          }
        )

        placed.add(id)
      }

      selected = desired

      saveSelection(
        selected
      )

      if (
        activeId &&
        !selected.has(activeId)
      ) {
        activeId = ''
      }

      renderFolder()

      setStatus(
        selected.size
          ? `${selected.size} menu item${selected.size === 1 ? '' : 's'} tucked into Folder.`
          : 'Menu Folder is empty. All moved items were returned.'
      )
    } catch (error: any) {
      setStatus(
        `Could not update Menu Folder: ${
          error?.message ||
          String(error)
        }`
      )
    } finally {
      applyButton.disabled = false
      clearButton.disabled = false
    }
  }

  settingsSection.addEventListener(
    'change',
    event => {
      const target =
        event.target as HTMLElement

      if (
        target.matches(
          '[data-lb-menu-folder-choice]'
        )
      ) {
        syncDraftFromInputs()

        setStatus(
          'Selection changed — press Apply menu folder.'
        )
      }
    }
  )

  applyButton.addEventListener(
    'click',
    () => {
      void applyDraft(true)
    }
  )

  clearButton.addEventListener(
    'click',
    () => {
      draft.clear()
      syncInputs()
      void applyDraft(true)
    }
  )

  openButton.addEventListener(
    'click',
    () => {
      folderTab.activate()
    }
  )

  const unsubscribeActivate =
    folderTab.onActivate?.(
      () => {
        renderFolder()
      }
    )

  renderFolder()

  void applyDraft(false)

  return () => {
    if (destroyed) return
    destroyed = true

    try {
      unsubscribeActivate?.()
    } catch {}

    for (
      const id of
        Array.from(placed)
    ) {
      try {
        ctx.ui.requestTabLocation(
          id,
          originalLocations.get(
            id
          ) || {
            kind:
              'main-drawer',
          }
        )
      } catch {}
    }

    for (
      const [id] of
        MENU_FOLDER_TARGETS
    ) {
      try {
        ctx.containers
          .unregisterContainer(
            containerIdFor(id)
          )
      } catch {}
    }

    try {
      folderTab.destroy()
    } catch {}

    try {
      settingsSection.remove()
    } catch {}

    try {
      removeStyle?.()
    } catch {}
  }
}
