import { kenBunnyDataUrl } from './ken-bunny-asset'

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

const bunnyImage = `<img class="ken-bunny" src="${kenBunnyDataUrl}" alt="Sleepy bunny lying on the chat textbox" draggable="false">`

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
.ken-bunny{width:88px;height:90px;object-fit:contain;display:block;transform-origin:50% 85%;animation:ken-breathe 2.3s ease-in-out infinite alternate}
.ken-pug{width:43px;height:40px;margin-left:-3px;margin-bottom:1px;display:none}
.ken-bedtime-with-pug .ken-pug{display:block;transform-origin:20% 85%;animation:ken-pet .8s ease-in-out 4 alternate}
@keyframes ken-arrive-left{from{transform:translateX(calc(-100vw - 300px))}to{transform:translateX(0)}}
@keyframes ken-breathe{to{transform:scaleY(.97)}}
@keyframes ken-pet{to{transform:rotate(-9deg) translateX(-2px)}}
@media(prefers-reduced-motion:reduce){.ken-bedtime,.ken-bunny,.ken-bedtime-with-pug .ken-pug{animation:none}}
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
      root.innerHTML = `<div class="ken-bedtime-bubble"><span class="ken-bedtime-line"></span><button type="button" class="ken-bedtime-close" aria-label="Dismiss bedtime reminder">×</button></div><div class="ken-bedtime-friends">${bunnyImage}${pugSvg}</div>`
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
