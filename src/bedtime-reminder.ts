import { kenBunnyDataUrl } from './ken-bunny-asset'
import { kenBunnyPugDataUrl } from './ken-bunny-pug-asset'

export const DEFAULT_BEDTIME = '22:00'
export const DEFAULT_WAKE_TIME = '06:00'

export function validClockTime(value: unknown): value is string {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
}

// A reminder window can cross midnight; that morning still belongs to last night.
export function bedtimeNight(now: Date, bedtime: string, wakeTime: string): string | null {
  if (!validClockTime(bedtime) || !validClockTime(wakeTime) || bedtime === wakeTime) return null
  const minute = now.getHours() * 60 + now.getMinutes()
  const start = Number(bedtime.slice(0, 2)) * 60 + Number(bedtime.slice(3))
  const end = Number(wakeTime.slice(0, 2)) * 60 + Number(wakeTime.slice(3))
  const overnight = start > end
  if (overnight ? minute < start && minute >= end : minute < start || minute >= end) return null
  const night = new Date(now)
  if (overnight && minute < end) night.setDate(night.getDate() - 1)
  return `${night.getFullYear()}-${String(night.getMonth() + 1).padStart(2, '0')}-${String(night.getDate()).padStart(2, '0')}`
}

export function createBedtimeGate(options: {
  now: () => Date
  config: () => { enabled: boolean; bedtime: string; wakeTime: string }
  hasOpenChat: () => boolean
  dismissedNight: () => string | null
  snoozedUntil: () => number
  isVisible: () => boolean
  show: () => void
}) {
  return {
    check() {
      const { enabled, bedtime, wakeTime } = options.config()
      if (!enabled || !options.hasOpenChat()) return
      const now = options.now()
      const night = bedtimeNight(now, bedtime, wakeTime)
      if (!night || options.dismissedNight() === night
        || options.snoozedUntil() > now.getTime() || options.isVisible()) return
      options.show()
    },
  }
}

const soloLines = [
  "I'm sleepy. You should go to bed too.",
  'Maybe you should take melatonin.',
  'Does “one more reply” ever mean one?',
  'The story will still be here tomorrow, promise.',
  'Even bunnies need sleep.',
  'Let’s get cozy and call it a night.',
  'Your pillow misses you.',
  'Sleep is a pretty good plot twist.',
  'You can pick this up tomorrow.',
  'The moon called. It says bedtime.',
  'That last reply can be tomorrow’s first.',
  'Let’s give your eyes a little break.',
  'I’m keeping your spot warm.',
  'You’ve earned a soft landing tonight.',
  'Your blankets are waiting.',
  'I admire your dedication. Your pillow doesn’t.',
  'Your bedtime has been waiting very patiently.',
  'Perhaps the cliffhanger can wait.',
  'No need to finish the whole story tonight.',
  'One more reply sounds suspiciously familiar.',
  'Let’s save some magic for tomorrow.',
  'You can log off without losing the moment.',
  'The chat will be here when you wake up.',
  'Your sleepy bunny recommends a blanket.',
  'I’m not judging. I’m just yawning at you.',
  'I’m about to fall asleep on your keyboard.',
  'Let’s put this adventure on pause.',
  'Even heroes need to recharge.',
  'The next scene can wait until morning.',
  'Come on, let’s call it a night.',
  'Your eyes could use a happy ending tonight.',
  'Wouldn’t a little rest feel nice?',
  'I think your blanket is winning.',
  'One more minute? Famous last words.',
  'I’ll be here when the sun comes up.',
  'Sleep first. Plot twists later.',
]

const pugLines = [
  "I'm sleepy. Come rest with us.",
  'The pug’s ready for bed. Are you?',
  'The pug has claimed the pillow. There’s room for you.',
  'I think “one more reply” became a whole chapter.',
  'Maybe you should take melatonin.',
  'The pug voted for sleep. I second that.',
  'Look at those sleepy eyes. We’re outnumbered.',
  'He wants a cuddle break.',
  'The pug and I saved you a cozy spot.',
  'Even your biggest fan needs bedtime.',
  'The pug says the next chapter can wait.',
  'He’s already dreaming of tomorrow’s scene.',
  'Shh. Someone’s almost asleep.',
  'We’re both waiting under the blanket.',
  'He asked for one last pat, not one last reply.',
  'Let’s give this story a soft pause.',
  'Two sleepy faces are looking at you.',
  'The pug has officially clocked out.',
  'His bedtime yawn was a hint.',
  'Come join our little sleep pile.',
  'He’s pretending he’s awake for you.',
  'The pug’s snoring is a gentle suggestion.',
  'Maybe bedtime can be our next adventure.',
  'You can make him the hero again tomorrow.',
]

const bunnyImage = `<img class="ken-bunny" src="${kenBunnyDataUrl}" alt="Sleepy bunny lying on the chat textbox" draggable="false">`

const bunnyPugImage = `<img class="ken-duo" src="${kenBunnyPugDataUrl}" alt="Bunny resting one paw on the sleepy pug's head" draggable="false">`

const style = `
.ken-bedtime{position:fixed;z-index:2147483000;pointer-events:none;display:flex;flex-direction:column;align-items:flex-start;max-width:min(280px,calc(100vw - 24px));filter:drop-shadow(0 6px 11px rgba(15,12,18,.17));animation:ken-arrive-left .8s cubic-bezier(.2,.9,.25,1) both}
.ken-bedtime-bubble{position:relative;max-width:220px;min-width:155px;margin-left:22px;padding:9px 11px;border:2px solid #373037;border-radius:16px 19px 15px 6px;background:#fffefa;color:#302a30;font:600 13px/1.3 system-ui,sans-serif;pointer-events:auto}
.ken-bedtime-bubble::after{content:"";position:absolute;left:20px;bottom:-8px;width:13px;height:13px;background:#fffefa;border-right:2px solid #373037;border-bottom:2px solid #373037;transform:rotate(45deg)}
.ken-bedtime-actions{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-top:7px}
.ken-bedtime-actions button{padding:4px 6px;border:1px solid #ad9aa6;border-radius:7px;background:#f7e8ee;color:#302a30;font:600 11px/1.2 system-ui,sans-serif;cursor:pointer}
.ken-bedtime-actions .ken-bedtime-dismiss{background:transparent}
.ken-bedtime-actions button:focus-visible{outline:2px solid #705361;outline-offset:2px}
.ken-bedtime-friends{position:relative;display:flex;align-items:flex-end;flex:none;margin-top:2px}
.ken-bunny{width:88px;height:90px;object-fit:contain;display:block;transform-origin:50% 85%;animation:ken-breathe 2.3s ease-in-out infinite alternate}
.ken-duo{width:142px;height:99px;object-fit:contain;display:block;transform-origin:50% 85%;animation:ken-breathe 2.3s ease-in-out infinite alternate}
@keyframes ken-arrive-left{from{transform:translateX(calc(-100vw - 300px))}to{transform:translateX(0)}}
@keyframes ken-breathe{to{transform:scaleY(.97)}}
@media(prefers-reduced-motion:reduce){.ken-bedtime,.ken-bunny,.ken-duo{animation:none}}
`

export function createBedtimeCompanion(doc: Document, options: {
  onDismiss: () => void
  onSnooze: (minutes: number) => void
  snoozeMinutes: () => number
  random?: () => number
}) {
  const random = options.random ?? Math.random
  const css = doc.createElement('style')
  css.textContent = style
  doc.head.append(css)
  let root: HTMLElement | null = null
  const bags = { solo: [] as number[], pug: [] as number[] }
  const last = { solo: -1, pug: -1 }
  const nextLine = (withPug: boolean) => {
    const kind = withPug ? 'pug' : 'solo'
    const lines = withPug ? pugLines : soloLines
    if (!bags[kind].length) {
      const bag = lines.map((_, index) => index)
      for (let index = bag.length - 1; index > 0; index--) {
        const swap = Math.floor(random() * (index + 1))
        ;[bag[index], bag[swap]] = [bag[swap], bag[index]]
      }
      if (bag.length > 1 && bag[bag.length - 1] === last[kind]) {
        ;[bag[0], bag[bag.length - 1]] = [bag[bag.length - 1], bag[0]]
      }
      bags[kind] = bag
    }
    const picked = bags[kind].pop()!
    last[kind] = picked
    return lines[picked]
  }
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
    root?.remove()
    root = null
    doc.defaultView?.removeEventListener('resize', position)
    doc.defaultView?.removeEventListener('scroll', position, true)
  }
  return {
    isVisible: () => Boolean(root),
    show(preview = false) {
      if (root) return
      const withPug = random() < 0.3
      const line = nextLine(withPug)
      root = doc.createElement('aside')
      root.className = `ken-bedtime${withPug ? ' ken-bedtime-with-pug' : ''}`
      root.setAttribute('role', 'region')
      root.setAttribute('aria-label', 'Bedtime reminder')
      root.setAttribute('aria-live', 'polite')
      root.innerHTML = `<div class="ken-bedtime-bubble"><span class="ken-bedtime-line"></span><div class="ken-bedtime-actions"><button type="button" class="ken-bedtime-snooze">Snooze</button><button type="button" class="ken-bedtime-dismiss" aria-label="Leave for tonight" title="Dismiss for tonight">Leave</button></div></div><div class="ken-bedtime-friends">${withPug ? bunnyPugImage : bunnyImage}</div>`
      root.querySelector('.ken-bedtime-line')!.textContent = line
      const snoozeButton = root.querySelector('.ken-bedtime-snooze') as HTMLButtonElement
      const minutes = Math.min(120, Math.max(1, Math.round(options.snoozeMinutes())))
      snoozeButton.setAttribute('aria-label', `Snooze for ${minutes} minutes`)
      snoozeButton.title = `Come back in ${minutes} minutes`
      snoozeButton.addEventListener('click', () => {
        if (!preview) options.onSnooze(minutes)
        remove()
      })
      root.querySelector('.ken-bedtime-dismiss')!.addEventListener('click', () => {
        if (!preview) options.onDismiss()
        remove()
      })
      doc.body.append(root)
      position()
      doc.defaultView?.addEventListener('resize', position)
      doc.defaultView?.addEventListener('scroll', position, true)
    },
    hide: remove,
    destroy() { remove(); css.remove() },
  }
}
