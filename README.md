# Arrow Chrono

An offline-capable PWA that measures arrow speed acoustically. It times the gap between
the sound of the shot and the sound of the impact, corrects for the time sound takes to
travel back to the phone, and divides distance by flight time.

**Live:** https://sims158.github.io/arrow-chrono/

No backend, no build step, no dependencies — nine static files. Everything (microphone
capture, DSP, physics) runs in the browser.

## How it works

The bow fires at `x=0` at `t=0`. The phone sits at `x=m`. The arrow hits at `x=D` at
time `T`. The microphone hears the shot at `m/(c+w)` and the impact at
`T + (D−m)/(c−w)`, where `c` is the speed of sound and `w` is the wind component blowing
downrange. So the measured gap is:

```
dt = T + (D − m)/(c − w) − m/(c + w)
```

Rearranged, `T = dt − correction`, and average speed is `D / T`.

With the phone **exactly midway and no wind the correction is zero** — the two sound
paths cancel and air temperature stops mattering entirely. That's why the midway option
is the accurate one.

Timing comes from the audio sample clock rather than any wall-clock timer, giving ~21 µs
resolution at 48 kHz — about 0.01% of a typical flight time. Distance measurement, not
timing, is the limiting factor.

## Using it

1. Measure the distance from the shooting line to the target face. A 1% distance error
   is roughly a 1.2% speed error, so this is worth doing properly.
2. Choose where the phone sits. **Midway** is the accurate option. **At the bow** is more
   convenient but relies on your temperature reading.
3. Tap **Start listening** and shoot.

**One shot per arm.** After a valid reading the mic is released — the AudioContext
closes, the wake lock drops, and iOS's recording indicator goes out. The button becomes
"Listen for next shot". A shot that produces *no* valid impact re-arms instead of
stopping, so a cough or a dropped quiver can't silently end a session before you shoot.

Watch the level meter between shots. The tick mark is the trigger threshold, the bar is
the current level. If impacts never register, lower the sensitivity in Advanced (it's a
multiple of the tracked noise floor). If wind or chatter triggers it, raise the
sensitivity or raise the high-pass frequency.

### Smoke test without a bow

Start listening and clap twice, roughly a third of a second apart. Open **Advanced** and
check the debug log for a `shot` line and a `hit?` line with the gap in milliseconds.
The speed will be meaningless, but it proves mic → worklet → onset detection works on
that specific device. Worth doing before driving to the range.

## What it actually measures

**Average speed over the flight, not launch speed.** An arrow sheds roughly 1–2 ft/s per
yard, so a 20-yard reading sits a few percent below what an optical or radar chronograph
at the bow would report. Two ways to handle it:

- Set **arrow drag k** in Advanced (0.0045 /m ≈ 1.2 ft/s per yard) and it reports an
  estimated launch speed alongside the average, using `v(x) = v₀·e^(−kx)`.
- Better: shoot the same setup at two distances. The difference in average speed gives
  your actual `k`, so everything downstream is measured rather than assumed.

## Accuracy notes

- The loudest part of the bow noise happens as the limbs stop, a few milliseconds after
  the arrow leaves. That's a small systematic bias. If you get access to a real
  chronograph, trim it out once with **Timing offset** in Advanced.
- A phone placed midway also hears the arrow pass overhead. The app collects every onset
  in the plausible window, picks the loudest, and shows the alternatives as chips under
  the reading so you can reassign a shot if it chose wrong.
- Foam targets are quiet. If impacts aren't detected, shoot a bag or block target, or
  shorten the distance.
- **STD DEV is the number to watch.** It tells you whether the acoustic method itself is
  behaving. Under ~1 ft/s means the timing is solid; a large value means something is
  mis-triggering.

## Shipping an update

```bash
./release.sh "What changed"
```

That bumps the service worker cache version, commits and pushes. GitHub Pages rebuilds
within about a minute.

**The version bump is the entire release mechanism.** Without it, installed clients keep
serving the old cache no matter how many times you deploy. The script aborts rather than
pushing if it can't find the `CACHE` line in `sw.js`, so a rename can't silently break
releases.

For documentation-only changes, a plain `git commit` / `git push` is better — no need to
prompt every user to reload for a README edit.

When a new version is live, the app detects it, installs it in the background, and shows
a "New version ready" bar. The new worker waits rather than taking over, so a reload
never happens mid-session. The prompt warns you if reloading would stop active listening,
and releases the mic cleanly first.

## Files

| File | Purpose |
|---|---|
| `index.html` | Markup, design tokens, styles |
| `app.js` | State machine, physics, UI |
| `worklet.js` | Onset detector, runs on the audio thread |
| `sw.js` | Cache-first service worker — `CACHE` is the version |
| `manifest.webmanifest` | Install metadata |
| `release.sh` | Bump cache version, commit, push |

## Interface

Dark throughout (`#151515`) with the readout as a true-black instrument panel, modelled
on the Garmin Xero C1 Pro: stacked unit letters, shot count, and AVG / STD DEV / MAX
beneath the main reading. The panel header repurposes the Garmin's three slots — battery
becomes a five-segment mic level meter, the mode label becomes the current distance, and
the Bluetooth glyph becomes a LIVE indicator.

Contrast was checked rather than eyeballed: body text 16:1, muted labels 7.7:1, muted on
input surfaces 6.9:1.

Note that dark is harder to read in direct sun than light. If that becomes a problem at
the range, add a `@media (prefers-color-scheme: light)` block — the tokens are isolated
at the top of the CSS in `index.html`, so it's one extra block of variables and nothing
else changes.

## Platform quirks

- **`echoCancellation`, `noiseSuppression` and `autoGainControl` are all explicitly
  disabled** in `getUserMedia`. Leaving any of them on smears the transients and the
  timing falls apart. Some Android OEMs apply processing anyway.
- iOS needs a user gesture before the AudioContext will start; the Start button provides
  it. Don't try to auto-start on load.
- Mic access in iOS home-screen web apps has a history of being flaky — reports of it
  working on first launch in standalone mode then failing until a restart. If that
  happens, run it from a Safari tab instead; the service worker still caches per-origin,
  so offline works fine there.
- **Add to Home Screen is Safari-only** on iOS. Chrome for iOS can't do it.
- Screen wake lock is requested while listening, and silently skipped where unsupported.
- The mic requires a secure context. `localhost` counts; a LAN address like
  `192.168.x.x` does not. For phone testing off a laptop, use a tunnel
  (`npx cloudflared tunnel --url http://localhost:3000`) or just push to Pages.
