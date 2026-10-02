export const KEN_SLEEP_DISMISSED_KEY = 'lumiverse:lumi-toolkit:ken-sleep-dismissed-night'

// The hours after midnight belong to the previous evening's reminder.
export function kenSleepNight(now: Date): string | null {
  const hour = now.getHours()
  if (hour >= 6 && hour < 22) return null
  const night = new Date(now)
  if (hour < 6) night.setDate(night.getDate() - 1)
  return `${night.getFullYear()}-${String(night.getMonth() + 1).padStart(2, '0')}-${String(night.getDate()).padStart(2, '0')}`
}

export function createKenSleepGate(options: {
  activeChatId: () => string | null
  now: () => Date
  dismissedNight: () => string | null
  show: () => void
}) {
  let chatId: string | null = null
  let count = 0
  let shown = false
  let lastShownAt = 0
  let currentNight: string | null = null
  return {
    onMessage(payload: { chatId?: unknown; personaName?: unknown; isUser?: unknown }) {
      const active = options.activeChatId()
      if (!active || payload.chatId !== active) return
      if (chatId !== active) { chatId = active; count = 0 }
      if (payload.isUser !== true) return
      if (payload.personaName !== 'Ken') { count = 0; return }
      const now = options.now()
      const night = kenSleepNight(now)
      if (!night || options.dismissedNight() === night) { count = 0; return }
      if (night !== currentNight) { currentNight = night; count = 0; shown = false; lastShownAt = 0 }
      count++
      const threshold = shown ? 6 : 2
      if (count < threshold || (shown && now.getTime() - lastShownAt < 15 * 60_000)) return
      count = 0
      shown = true
      lastShownAt = now.getTime()
      options.show()
    },
  }
}

const lines = [
  "I'm sleepy. You should go to bed too.",
  'Maybe you should take melatonin.',
  'Even bunnies need sleep, Ken.',
  'The next reply can wait until morning.',
  'Let’s get cozy and call it a night.',
]

const bunnySvg = `<svg class="ken-bunny" viewBox="0 0 150 110" role="img" aria-label="Sleepy bunny lying on the chat textbox" xmlns="http://www.w3.org/2000/svg">
  <ellipse cx="73" cy="102" rx="61" ry="5" fill="#18151a" opacity=".17"/>
  <path d="M24 70C11 67 8 77 13 86C19 96 31 91 36 83" fill="#fffefa" stroke="#302a30" stroke-width="3.2" stroke-linejoin="round" stroke-linecap="round"/>
  <path class="ken-ear" d="M41 48C28 37 17 26 23 18C29 9 43 21 54 41" fill="#fffefa" stroke="#302a30" stroke-width="3.2" stroke-linejoin="round" stroke-linecap="round"/>
  <path d="M39 39C32 31 27 24 29 22C33 20 41 30 46 40" fill="#f3b0bd" stroke="none"/>
  <path d="M53 43C45 29 44 16 52 14C62 10 69 28 68 44" fill="#fffefa" stroke="#302a30" stroke-width="3.2" stroke-linejoin="round" stroke-linecap="round"/>
  <path d="M55 38C51 27 52 21 55 20C60 20 63 29 63 39" fill="#f3b0bd" stroke="none"/>
  <path class="ken-bunny-body" d="M30 53C39 44 53 43 65 43C76 41 91 43 98 48C116 48 128 62 129 78C131 91 119 99 103 100C87 103 50 101 37 99C23 98 18 86 21 73C22 64 25 58 30 53Z" fill="#fffefa" stroke="#302a30" stroke-width="3.2" stroke-linejoin="round" stroke-linecap="round"/>
  <path d="M67 68q4-5 9 0m17 0q4-5 9 0" fill="none" stroke="#302a30" stroke-width="3" stroke-linecap="round"/>
  <circle cx="83" cy="64" r="1.5" fill="#302a30"/><circle cx="107" cy="63" r="1.5" fill="#302a30"/>
  <path d="M84 78q4-4 7 0l-3 3z" fill="#ed9fac"/><path d="M88 81q-3 5-7 2m7-2q3 5 7 2" fill="none" stroke="#302a30" stroke-width="2.4" stroke-linecap="round"/>
  <path d="M111 84q7-4 12 0" fill="none" stroke="#302a30" stroke-width="2.5" stroke-linecap="round"/>
  <path class="ken-paw" d="M107 92q14-9 24-4q7 4 3 10q-5 5-16 1" fill="#fffefa" stroke="#302a30" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="80" y="34" fill="#766b78" font-family="system-ui,sans-serif" font-size="14" font-weight="700">z</text><text x="91" y="25" fill="#766b78" font-family="system-ui,sans-serif" font-size="10" font-weight="700">z</text>
</svg>`

const pugSvg = `<svg class="ken-pug" viewBox="0 0 100 92" role="img" aria-label="Little pug being petted" xmlns="http://www.w3.org/2000/svg">
  <ellipse cx="49" cy="73" rx="38" ry="17" fill="#b89169" stroke="#664c42" stroke-width="3"/>
  <path d="M20 41q-14-21-6-29q12-7 23 11M78 41q16-22 8-29q-12-7-24 11" fill="#664c42" stroke="#664c42" stroke-width="3"/>
  <ellipse cx="49" cy="41" rx="35" ry="33" fill="#cba77c" stroke="#664c42" stroke-width="3"/>
  <ellipse cx="49" cy="55" rx="21" ry="16" fill="#66504a"/>
  <circle cx="35" cy="38" r="4" fill="#2f2527"/><circle cx="64" cy="38" r="4" fill="#2f2527"/>
  <ellipse cx="49" cy="52" rx="7" ry="5" fill="#2f2527"/><path d="M49 57q-5 6-10 4m10-4q5 6 10 4" fill="none" stroke="#2f2527" stroke-width="2" stroke-linecap="round"/>
</svg>`

const style = `
.ken-bedtime{position:fixed;z-index:2147483000;pointer-events:none;display:flex;flex-direction:column;align-items:flex-start;max-width:min(280px,calc(100vw - 24px));filter:drop-shadow(0 6px 11px rgba(15,12,18,.17));animation:ken-arrive-left .8s cubic-bezier(.2,.9,.25,1) both}
.ken-bedtime-bubble{position:relative;max-width:245px;min-width:150px;margin-left:22px;padding:11px 29px 11px 14px;border:2px solid #373037;border-radius:16px 19px 15px 6px;background:#fffefa;color:#302a30;font:600 14px/1.35 system-ui,sans-serif;pointer-events:auto}
.ken-bedtime-bubble::after{content:"";position:absolute;left:20px;bottom:-8px;width:13px;height:13px;background:#fffefa;border-right:2px solid #373037;border-bottom:2px solid #373037;transform:rotate(45deg)}
.ken-bedtime-close{position:absolute;right:5px;top:3px;border:0;background:transparent;color:#705361;font:700 20px/1 system-ui,sans-serif;cursor:pointer;padding:2px 5px}
.ken-bedtime-close:focus-visible{outline:2px solid #705361;border-radius:4px}
.ken-bedtime-friends{display:flex;align-items:flex-end;flex:none;margin-top:2px}
.ken-bunny{width:132px;height:97px;overflow:visible}
.ken-bunny-body{transform-origin:75px 80px;animation:ken-breathe 2.3s ease-in-out infinite alternate}
.ken-ear{transform-origin:41px 48px;animation:ken-ear-twitch 4s ease-in-out infinite alternate}
.ken-pug{width:51px;height:49px;margin-left:-13px;margin-bottom:2px;display:none}
.ken-bedtime-with-pug .ken-pug{display:block}
.ken-bedtime-with-pug .ken-paw{transform-origin:108px 92px;animation:ken-pet .8s ease-in-out 4 alternate}
@keyframes ken-arrive-left{from{transform:translateX(calc(-100vw - 300px))}to{transform:translateX(0)}}
@keyframes ken-breathe{to{transform:scaleY(.94)}}
@keyframes ken-ear-twitch{to{transform:rotate(-5deg)}}
@keyframes ken-pet{to{transform:rotate(-16deg)}}
@media(prefers-reduced-motion:reduce){.ken-bedtime,.ken-bunny-body,.ken-ear,.ken-bedtime-with-pug .ken-paw{animation:none}}
`

export function createKenSleepCompanion(doc: Document, options: { onDismiss: () => void; random?: () => number }) {
  const random = options.random ?? Math.random
  const css = doc.createElement('style')
  css.textContent = style
  doc.head.append(css)
  let root: HTMLElement | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const position = () => {
    if (!root) return
    const composer = doc.querySelector('[data-component="InputArea"]')
    const rect = composer?.getBoundingClientRect()
    const view = doc.defaultView
    const width = view?.innerWidth ?? 1024, height = view?.innerHeight ?? 768
    const desiredLeft = rect ? rect.left + 12 : 12
    root.style.left = `${Math.max(12, Math.min(desiredLeft, width - root.offsetWidth - 12))}px`
    root.style.bottom = `${Math.max(16, rect ? height - rect.top - 19 : 80)}px`
  }
  const remove = () => {
    if (timer) clearTimeout(timer)
    timer = null
    root?.remove()
    root = null
    doc.defaultView?.removeEventListener('resize', position)
    doc.defaultView?.removeEventListener('scroll', position, true)
  }
  return {
    isVisible: () => Boolean(root),
    show(preview = false) {
      if (root) return
      const line = lines[Math.floor(random() * lines.length) % lines.length]
      const withPug = random() < 0.3
      root = doc.createElement('aside')
      root.className = `ken-bedtime${withPug ? ' ken-bedtime-with-pug' : ''}`
      root.setAttribute('role', 'status')
      root.setAttribute('aria-live', 'polite')
      root.innerHTML = `<div class="ken-bedtime-bubble"><span class="ken-bedtime-line"></span><button type="button" class="ken-bedtime-close" aria-label="Dismiss bedtime reminder">×</button></div><div class="ken-bedtime-friends">${bunnySvg}${pugSvg}</div>`
      root.querySelector('.ken-bedtime-line')!.textContent = line
      root.querySelector('.ken-bedtime-close')!.addEventListener('click', () => { if (!preview) options.onDismiss(); remove() })
      doc.body.append(root)
      position()
      doc.defaultView?.addEventListener('resize', position)
      doc.defaultView?.addEventListener('scroll', position, true)
      timer = setTimeout(remove, 16_000)
    },
    hide: remove,
    destroy() { remove(); css.remove() },
  }
}
