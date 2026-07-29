# Arrow Chrono

An offline-capable PWA that measures arrow speed acoustically: it times the gap between
the sound of the shot and the sound of the impact, corrects for the time sound takes to
travel back to the phone, and divides distance by flight time.

## Running it

The microphone requires a secure context, so `file://` won't work. Any of these will:

```bash
# local testing
npx serve .          # then open the https:// URL, or use localhost (treated as secure)
```

For real use, drop the folder in a GitHub Pages repo (or Netlify / Cloudflare Pages).
Open it in Chrome or Safari, then **Add to Home Screen**. After the first load the
service worker caches everything, so it runs with no signal at the range.

## Using it

1. Measure the distance from the shooting line to the target face. This is the single
   biggest source of error — a 1% distance error is roughly a 1.2% speed error.
2. Choose where the phone sits. **Midway is the accurate option**: the outbound and
   return sound paths cancel exactly, so air temperature drops out of the maths
   completely. At the bow is more convenient but needs a temperature reading.
3. Tap **Start listening** and shoot. It re-arms automatically after each shot.

Watch the meter between shots. The tick mark is the trigger threshold; the bar is the
current level. If the impact never registers, lower the sensitivity number in Advanced
(it's a multiple of the tracked noise floor). If wind or chatter triggers it, raise the
sensitivity or raise the high-pass frequency.

## What it actually measures

**Average speed over the flight, not launch speed.** An arrow sheds roughly 1–2 ft/s per
yard, so a 20-yard reading sits a few percent below what an optical or radar chronograph
at the bow would report. Two ways to handle it:

- Set **arrow drag k** in Advanced (0.0045 /m ≈ 1.2 ft/s per yard) and it reports an
  estimated launch speed alongside the average, using `v(x) = v₀·e^(−kx)`.
- Better: shoot the same setup at two distances, and the difference in average speed
  gives you your actual `k`. Then everything downstream is real rather than assumed.

## Accuracy notes

- Timing resolution is one audio sample — about 21 µs at 48 kHz, which is ~0.01% of a
  typical flight time. Timing is not your limiting factor; distance and the bow-noise
  onset are.
- The loudest part of the bow noise happens as the limbs stop, a few milliseconds after
  the arrow actually leaves. That's a small systematic bias. If you ever get access to a
  real chronograph, trim it out once with **Timing offset** in Advanced.
- A phone placed midway also hears the arrow pass overhead. The app collects every onset
  in the plausible window and picks the loudest, then shows the alternatives as chips
  under the reading so you can reassign a shot if it picked wrong.
- Foam targets are quiet. If impacts aren't detected, shoot a bag or block target, or
  shorten the distance.

## Files

| File | Purpose |
|---|---|
| `index.html` | Markup and styles |
| `app.js` | State machine, physics, UI |
| `worklet.js` | Onset detector, runs on the audio thread |
| `sw.js` | Cache-first service worker — bump `CACHE` when you edit anything |

## Shipping an update

Edit whatever you like, then bump one line in `sw.js`:

```js
const CACHE = 'arrow-chrono-v3';
```

Push. Next time someone opens the app it fetches `sw.js`, sees it differs, and installs
the new version into a fresh cache **in the background**. The new worker then waits — it
does not take over. The page shows a "New version ready" bar with a Reload button, and
only when that's tapped does the handover happen.

This matters at the range: without it, a browser-initiated reload could land in the
middle of a shot session. The prompt also changes its wording to warn you if reloading
will stop an active listening session, and releases the mic cleanly before reloading.

The app re-checks for updates when it becomes visible again and every thirty minutes.
If you forget to bump `CACHE`, nothing happens — users keep the old version forever.
That one line is the whole release mechanism.
| `manifest.webmanifest` | Install metadata |

## Known platform quirks

- iOS needs a user gesture before the AudioContext will start; the Start button provides
  it. Don't try to auto-start on load.
- `echoCancellation`, `noiseSuppression` and `autoGainControl` are all explicitly
  disabled in `getUserMedia`. Leaving any of them on smears the transients and the
  timing falls apart. Some Android OEMs apply processing anyway — if readings look
  systematically wrong on one device, test against another before blaming the maths.
- Screen wake lock is requested while listening, and silently skipped where unsupported.
