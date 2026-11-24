// One-shot motion for any section marked [data-play-section] (the capabilities bento, the use cases):
// armed (its animated pieces wait) until a third of it is on screen, played once ('in'), then 'done', which
// drops the entrance animations so a replay never hides anything. Hovering or tapping a [data-tile] inside a
// played section replays that tile's beat once (data-replay), never while it is still playing.
// A section sets how long its entrance and its replays run with data-play-ms and data-replay-ms (defaults
// 1400 and 1000), so a longer timeline (the use cases' packets) is never cut short.
//
// data-loop-ms makes a section continuous (the maintainer's call for the use cases, 2026-11-24): after the
// entrance, every tile replays its beat on that period, but only while the section is on screen and the tab is
// visible, and never the tile under the pointer (it holds still to be read). Each beat is still a finite
// animation started by a timer, so nothing on the page is an endless animation, and the timer itself stops
// whenever the section leaves the screen or the tab is hidden.
// Reduced motion, or no script, leaves every section in its finished state. No scroll or pointer-move
// listeners: IntersectionObservers, visibilitychange and pointerenter/click only.
if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
  for (const section of document.querySelectorAll<HTMLElement>('[data-play-section]')) {
    const playMs = Number(section.dataset.playMs) || 1400
    const replayMs = Number(section.dataset.replayMs) || 1000
    const loopMs = Number(section.dataset.loopMs) || 0
    const tiles = [...section.querySelectorAll<HTMLElement>('[data-tile]')]
    const replay = (tile: HTMLElement) => {
      if (section.dataset.play !== 'done' || tile.dataset.replay) return
      tile.dataset.replay = 'on'
      setTimeout(() => delete tile.dataset.replay, replayMs)
    }

    // the continuous loop: a timer that only exists while the section is on screen and the tab is visible
    let onScreen = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = () => {
      clearTimeout(timer)
      timer = undefined
    }
    const beat = () => {
      for (const tile of tiles) if (!tile.matches(':hover')) replay(tile)
      timer = setTimeout(beat, loopMs)
    }
    const start = (first = 600) => {
      if (!loopMs || timer || !onScreen || document.hidden || section.dataset.play !== 'done') return
      timer = setTimeout(beat, first)
    }
    if (loopMs) {
      new IntersectionObserver((entries) => {
        onScreen = entries.some((e) => e.isIntersecting)
        if (onScreen) start()
        else stop()
      }).observe(section)
      document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()))
    }

    section.dataset.play = 'armed'
    const seen = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return
        seen.disconnect()
        section.dataset.play = 'in'
        setTimeout(() => {
          section.dataset.play = 'done'
          start(1200)
        }, playMs)
      },
      { threshold: 0.3 },
    )
    seen.observe(section)
    for (const tile of tiles) {
      tile.addEventListener('pointerenter', () => replay(tile))
      tile.addEventListener('click', () => replay(tile))
    }
  }
}
