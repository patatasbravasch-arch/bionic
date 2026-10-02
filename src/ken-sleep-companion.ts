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

const bunnySvg = `<svg class="ken-bunny" viewBox="0 0 116 145" role="img" aria-label="Bedtime bunny" xmlns="http://www.w3.org/2000/svg">
  <ellipse class="ken-ear ken-ear-left" cx="42" cy="43" rx="13" ry="37" fill="#fff8f1" stroke="#714f55" stroke-width="3" transform="rotate(-12 42 43)"/>
  <ellipse cx="42" cy="42" rx="6" ry="25" fill="#f7b5c0" transform="rotate(-12 42 42)"/>
  <ellipse class="ken-ear ken-ear-right" cx="75" cy="42" rx="13" ry="38" fill="#fff8f1" stroke="#714f55" stroke-width="3" transform="rotate(12 75 42)"/>
  <ellipse cx="75" cy="40" rx="6" ry="25" fill="#f7b5c0" transform="rotate(12 75 40)"/>
  <ellipse class="ken-foot ken-foot-left" cx="37" cy="130" rx="17" ry="9" fill="#fff8f1" stroke="#714f55" stroke-width="3"/>
  <ellipse class="ken-foot ken-foot-right" cx="79" cy="130" rx="17" ry="9" fill="#fff8f1" stroke="#714f55" stroke-width="3"/>
  <ellipse cx="58" cy="105" rx="35" ry="31" fill="#fff8f1" stroke="#714f55" stroke-width="3"/>
  <circle cx="58" cy="72" r="39" fill="#fff8f1" stroke="#714f55" stroke-width="3"/>
  <ellipse cx="43" cy="75" rx="3.5" ry="5" fill="#433039"/><ellipse cx="74" cy="75" rx="3.5" ry="5" fill="#433039"/>
  <ellipse cx="34" cy="86" rx="8" ry="4" fill="#f8c1c7" opacity=".65"/><ellipse cx="82" cy="86" rx="8" ry="4" fill="#f8c1c7" opacity=".65"/>
  <path d="M53 86q5-5 10 0l-5 4z" fill="#ed91a3"/><path d="M58 90q-4 7-9 4m9-4q4 7 9 4" fill="none" stroke="#714f55" stroke-width="2.5" stroke-linecap="round"/>
  <path class="ken-paw" d="M83 101q23-7 25 7q1 7-7 7q-7 0-18-3" fill="#fff8f1" stroke="#714f55" stroke-width="3" stroke-linecap="round"/>
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
.ken-bedtime{position:fixed;z-index:2147483000;pointer-events:none;display:flex;align-items:flex-end;gap:0;max-width:min(360px,calc(100vw - 24px));filter:drop-shadow(0 9px 20px rgba(30,15,33,.22));animation:ken-arrive .9s cubic-bezier(.2,.9,.25,1) both}
.ken-bedtime-bubble{position:relative;align-self:flex-start;max-width:230px;min-width:150px;padding:13px 29px 13px 15px;border:2px solid #795a72;border-radius:17px 17px 5px 17px;background:#fffaf5;color:#382c3b;font:600 14px/1.35 system-ui,sans-serif;pointer-events:auto}
.ken-bedtime-bubble::after{content:"";position:absolute;right:-8px;bottom:18px;width:13px;height:13px;background:#fffaf5;border-right:2px solid #795a72;border-bottom:2px solid #795a72;transform:rotate(-45deg)}
.ken-bedtime-close{position:absolute;right:5px;top:3px;border:0;background:transparent;color:#705361;font:700 20px/1 system-ui,sans-serif;cursor:pointer;padding:2px 5px}
.ken-bedtime-close:focus-visible{outline:2px solid #705361;border-radius:4px}
.ken-bedtime-friends{display:flex;align-items:flex-end;flex:none;margin-left:-4px}
.ken-bunny{width:82px;height:104px;overflow:visible;animation:ken-bob .42s ease-in-out 4 alternate}
.ken-foot-left{transform-origin:37px 127px;animation:ken-step .3s ease-in-out 3 alternate}
.ken-foot-right{transform-origin:79px 127px;animation:ken-step .3s ease-in-out 3 alternate-reverse}
.ken-pug{width:60px;height:56px;margin-left:-21px;margin-bottom:1px;display:none}
.ken-bedtime-with-pug .ken-pug{display:block}
.ken-bedtime-with-pug .ken-paw{transform-origin:84px 104px;animation:ken-pet .55s ease-in-out 5 alternate}
@keyframes ken-arrive{from{transform:translateX(calc(100vw + 380px))}to{transform:translateX(0)}}
@keyframes ken-bob{to{transform:translateY(-5px)}}
@keyframes ken-step{to{transform:rotate(13deg)}}
@keyframes ken-pet{to{transform:rotate(-16deg)}}
@media(prefers-reduced-motion:reduce){.ken-bedtime,.ken-bunny,.ken-foot-left,.ken-foot-right,.ken-bedtime-with-pug .ken-paw{animation:none}}
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
    root.style.right = `${Math.max(12, rect ? width - rect.right : 12)}px`
    root.style.bottom = `${Math.max(16, rect ? height - rect.top + 8 : 80)}px`
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
    show() {
      if (root) return
      const line = lines[Math.floor(random() * lines.length) % lines.length]
      const withPug = random() < 0.3
      root = doc.createElement('aside')
      root.className = `ken-bedtime${withPug ? ' ken-bedtime-with-pug' : ''}`
      root.setAttribute('role', 'status')
      root.setAttribute('aria-live', 'polite')
      root.innerHTML = `<div class="ken-bedtime-bubble"><span class="ken-bedtime-line"></span><button type="button" class="ken-bedtime-close" aria-label="Dismiss bedtime reminder">×</button></div><div class="ken-bedtime-friends">${bunnySvg}${pugSvg}</div>`
      root.querySelector('.ken-bedtime-line')!.textContent = line
      root.querySelector('.ken-bedtime-close')!.addEventListener('click', () => { options.onDismiss(); remove() })
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
