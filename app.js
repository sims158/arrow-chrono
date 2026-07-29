/* Arrow Chrono — acoustic archery chronograph.
 *
 * Physics
 * -------
 * The bow fires at x=0 at t=0. The phone sits at x=m. The arrow hits at x=D
 * at t=T. The microphone therefore hears:
 *
 *   shot   at   m / (c + w)
 *   impact at   T + (D - m) / (c - w)
 *
 * where c is the speed of sound and w is the wind component blowing from the
 * archer toward the target. The measured gap is
 *
 *   dt = T + (D - m)/(c - w) - m/(c + w)
 *
 * so T = dt - correction, and the average speed over the flight is D / T.
 * Note that with the phone exactly midway and no wind the correction is zero:
 * the two sound paths cancel and air temperature stops mattering entirely.
 */

const $ = (id) => document.getElementById(id);
const el = {};
['status','speed','unit','detail','alts','bar','thr','lvl','floorTxt','go','dist','dunit',
 'micseg','michint','customwrap','micd','temp','wind','count','stats','list','emptyMsg',
 'csv','clear','sunit','weight','vmin','vmax','ratio','hp','offset','drag','log','toast',
 'update','updateMsg','updateBtn','updateDismiss',
 'segs','panelMode','panelLive','panelCount','pAvg','pSd','pMax']
  .forEach(k => el[k] = $(k));

const M_PER_YD = 0.9144, FPS = 3.280839895, MPH = 2.2369362920544;
const num = (n, d = 1) => Number.isFinite(n) ? n.toFixed(d) : '—';

let micMode = '0';
let shots = [];
let logLines = [];

/* ---------- settings ---------- */

const SETTINGS = ['dist','dunit','micd','temp','wind','sunit','weight','vmin','vmax',
                  'ratio','hp','offset','drag'];

function saveSettings() {
  try {
    const o = { micMode };
    SETTINGS.forEach(k => o[k] = el[k].value);
    localStorage.setItem('chrono.settings', JSON.stringify(o));
    localStorage.setItem('chrono.shots', JSON.stringify(shots));
  } catch (e) { /* private mode, sandboxed iframe — carry on in memory */ }
}

function loadSettings() {
  try {
    const o = JSON.parse(localStorage.getItem('chrono.settings') || '{}');
    SETTINGS.forEach(k => { if (o[k] != null) el[k].value = o[k]; });
    if (o.micMode) micMode = o.micMode;
    shots = JSON.parse(localStorage.getItem('chrono.shots') || '[]');
  } catch (e) { /* ignore */ }
}

function cfg() {
  const toM = el.dunit.value === 'yd' ? M_PER_YD : 1;
  const D = Math.max(0.5, (parseFloat(el.dist.value) || 0) * toM);
  let m = 0;
  if (micMode === 'half') m = D / 2;
  else if (micMode === 'custom') m = Math.min(D, Math.max(0, (parseFloat(el.micd.value) || 0) * toM));
  const T = parseFloat(el.temp.value);
  const c = 331.45 * Math.sqrt(1 + (Number.isFinite(T) ? T : 15) / 273.15);
  const w = Math.max(-30, Math.min(30, parseFloat(el.wind.value) || 0));
  return {
    D, m, c, w,
    correction: (D - m) / (c - w) - m / (c + w),
    offset: (parseFloat(el.offset.value) || 0) / 1000,
    vmin: Math.max(1, parseFloat(el.vmin.value) || 30),
    vmax: Math.max(2, parseFloat(el.vmax.value) || 200),
    k: Math.max(0, parseFloat(el.drag.value) || 0),
    grains: Math.max(0, parseFloat(el.weight.value) || 0)
  };
}

/* ---------- unit helpers ---------- */

function toUnit(ms) {
  const u = el.sunit.value;
  return u === 'fps' ? ms * FPS : u === 'mph' ? ms * MPH : ms;
}
const unitLabel = () => ({ fps: 'FPS', ms: 'M/S', mph: 'MPH' })[el.sunit.value];
const unitDigits = () => 1;

/* ---------- audio ---------- */

let ctx = null, node = null, stream = null, wakeLock = null;
let mode = 'off';           // off | listening | flight | cooldown
let shotSample = 0, candidates = [], flightTimer = null, sr = 48000;

async function start() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // All three of these destroy the transients we depend on. Turn them off.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1
      }
    });
  } catch (e) {
    setStatus('error', 'MIC');
    el.detail.textContent = 'Microphone blocked. Allow mic access and reload — the page must be served over HTTPS.';
    return;
  }

  ctx = new (window.AudioContext || window.webkitAudioContext)();
  await ctx.resume();
  sr = ctx.sampleRate;

  try {
    await ctx.audioWorklet.addModule('worklet.js');
  } catch (e) {
    setStatus('error', 'ERR');
    el.detail.textContent = 'This browser could not load the audio processor.';
    return;
  }

  node = new AudioWorkletNode(ctx, 'onset-processor', { numberOfOutputs: 0 });
  node.port.onmessage = onAudioMessage;
  ctx.createMediaStreamSource(stream).connect(node);
  pushParams();

  mode = 'listening';
  el.go.textContent = 'Stop';
  el.go.classList.add('on');
  setStatus('listening', 'LISTENING');
  el.detail.textContent = `Ready — ${(sr / 1000).toFixed(1)} kHz, ${(1e6 / sr).toFixed(0)} µs resolution.`;
  log(`started · ${sr} Hz · correction ${(cfg().correction * 1000).toFixed(1)} ms`);

  try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* optional */ }
}

function stop() {
  if (flightTimer) clearTimeout(flightTimer);
  if (node) { node.port.onmessage = null; node.disconnect(); node = null; }
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  if (ctx) { ctx.close(); ctx = null; }
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  mode = 'off';
  el.go.textContent = shots.length ? 'Listen for next shot' : 'Start listening';
  el.go.classList.remove('on');
  setStatus('off', 'OFF');
  el.bar.style.width = '0%';
  [...el.segs.children].forEach(seg => seg.classList.remove('on', 'hot'));
  el.lvl.textContent = '—';
  el.floorTxt.textContent = '';
}

function pushParams() {
  if (!node) return;
  node.port.postMessage({
    ratio: Math.max(1.5, parseFloat(el.ratio.value) || 8),
    hpHz: Math.max(100, parseFloat(el.hp.value) || 750),
    holdMs: 30
  });
}

/* ---------- detection state machine ---------- */

function onAudioMessage(e) {
  const d = e.data;
  if (d.t === 'level') return drawMeter(d);
  if (d.t !== 'onset') return;

  if (mode === 'listening') {
    shotSample = d.sample;
    candidates = [];
    mode = 'flight';
    setStatus('flight', 'FLIGHT');
    const c = cfg();
    const dtMax = c.correction + c.D / c.vmin;
    flightTimer = setTimeout(resolve, dtMax * 1000 + 200);
    log(`shot  · ${db(d.peak)} dBFS`);
  } else if (mode === 'flight') {
    const dt = (d.sample - shotSample) / sr;
    candidates.push({ dt, peak: d.peak });
    log(`  hit? · ${(dt * 1000).toFixed(1)} ms · ${db(d.peak)} dBFS`);
  }
}

function resolve() {
  flightTimer = null;
  const c = cfg();
  const dtMin = c.correction + c.D / c.vmax;
  const dtMax = c.correction + c.D / c.vmin;

  const valid = candidates.filter(x => x.dt >= dtMin && x.dt <= dtMax);
  if (!valid.length) {
    // A false trigger (a cough, a door) must not end the session — the archer
    // hasn't actually shot yet. Re-arm and keep waiting.
    el.detail.textContent = candidates.length
      ? 'No impact in the plausible window — check distance, or widen the speed range.'
      : 'Heard the shot but never the impact. Move the phone, or lower the trigger sensitivity.';
    el.alts.innerHTML = '';
    log('  → discarded, still listening');

    mode = 'cooldown';
    setStatus('off', 'WAIT');
    setTimeout(() => {
      if (mode !== 'cooldown') return;
      mode = 'listening';
      setStatus('listening', 'LISTENING');
    }, 900);
    return;
  }

  // The impact is normally the loudest thing in the window. An arrow passing
  // a midway-mounted phone also makes a noise, so pick by level, not by order.
  let best = valid[0];
  for (const v of valid) if (v.peak > best.peak) best = v;
  const ok = addShot(best.dt, valid);

  if (ok) {
    stop();                       // one shot per arm: release the mic
    toast('Shot recorded — mic off');
    log('  → recorded, mic released');
  } else {
    mode = 'listening';
    setStatus('listening', 'LISTENING');
  }
}

/* ---------- results ---------- */

function solve(dt, c) {
  const T = dt - c.correction - c.offset;
  if (!(T > 0)) return null;
  const vAvg = c.D / T;
  let v0 = null, vImpact = null;
  if (c.k > 0) {
    // Quadratic drag gives v(x) = v0·e^(-kx), so the distance-averaged speed
    // relates to launch speed by v_avg = v0·kD / (e^(kD) - 1).
    v0 = vAvg * (Math.exp(c.k * c.D) - 1) / (c.k * c.D);
    vImpact = v0 * Math.exp(-c.k * c.D);
  }
  return { T, vAvg, v0, vImpact };
}

function addShot(dt, alts) {
  const c = cfg();
  const r = solve(dt, c);
  if (!r) {
    el.detail.textContent = 'Interval too short to be real — check the distance setting.';
    return false;
  }
  shots.push({ dt, t: Date.now(), alts: alts.map(a => a.dt) });
  render();
  saveSettings();
  return true;
}

function render() {
  const c = cfg();
  const last = shots[shots.length - 1];
  const label = unitLabel();

  // Stacked unit letters beside the big number, Garmin-style.
  el.unit.innerHTML = '';
  [...label].forEach(ch => {
    const i = document.createElement('i');
    i.textContent = ch;
    el.unit.appendChild(i);
  });
  document.querySelectorAll('[data-u]').forEach(n => n.textContent = label);

  const dv = parseFloat(el.dist.value) || 0;
  el.panelMode.textContent =
    `${Number.isInteger(dv) ? dv : dv.toFixed(1)} ${el.dunit.value === 'yd' ? 'YD' : 'M'}`;
  el.panelCount.textContent = shots.length;

  if (!last) {
    el.speed.textContent = '—';
    el.speed.classList.add('idle');
    el.alts.innerHTML = '';
  } else {
    const r = solve(last.dt, c);
    el.speed.classList.remove('idle');
    el.speed.textContent = num(toUnit(r.vAvg), unitDigits());

    const bits = [
      `flight <b>${(r.T * 1000).toFixed(1)} ms</b>`,
      `gap ${(last.dt * 1000).toFixed(1)} ms`
    ];
    if (r.v0) bits.push(`launch <b>${num(toUnit(r.v0), unitDigits())}</b>`);
    if (c.grains > 0) {
      const fps = r.vAvg * FPS;
      bits.push(`${(c.grains * fps * fps / 450240).toFixed(1)} ft·lb`);
    }
    el.detail.innerHTML = bits.join(' &nbsp;·&nbsp; ');

    el.alts.innerHTML = '';
    if (last.alts && last.alts.length > 1) {
      last.alts.forEach(dt => {
        const rr = solve(dt, c);
        if (!rr) return;
        const b = document.createElement('button');
        b.textContent = `${(dt * 1000).toFixed(0)} ms → ${num(toUnit(rr.vAvg), unitDigits())}`;
        if (Math.abs(dt - last.dt) < 1e-9) b.style.borderColor = 'var(--ink)';
        b.onclick = () => { last.dt = dt; render(); saveSettings(); };
        el.alts.appendChild(b);
      });
    }
  }

  const speeds = shots.map(s => solve(s.dt, c)).filter(Boolean).map(r => toUnit(r.vAvg));
  const d = unitDigits();
  if (speeds.length) {
    const n = speeds.length;
    const mean = speeds.reduce((a, b) => a + b, 0) / n;
    const sd = n > 1
      ? Math.sqrt(speeds.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1))
      : 0;
    el.pAvg.textContent = mean.toFixed(d);
    el.pSd.textContent = n > 1 ? sd.toFixed(d) : '—';
    el.pMax.textContent = Math.max(...speeds).toFixed(d);
  } else {
    el.pAvg.textContent = el.pSd.textContent = el.pMax.textContent = '—';
  }

  el.count.textContent = shots.length ? `· ${shots.length}` : '';
  el.emptyMsg.hidden = shots.length > 0;

  el.list.innerHTML = '';
  shots.slice().reverse().forEach((s, i) => {
    const r = solve(s.dt, c);
    const idx = shots.length - i;
    const li = document.createElement('li');
    li.innerHTML = `<span class="idx">${idx}</span>` +
      `<span class="v">${r ? num(toUnit(r.vAvg), d) : '—'}</span>` +
      `<span class="d">${(s.dt * 1000).toFixed(1)} ms</span>`;
    const x = document.createElement('button');
    x.className = 'x'; x.textContent = '×'; x.title = 'Delete shot';
    x.onclick = () => { shots.splice(shots.length - 1 - i, 1); render(); saveSettings(); };
    li.appendChild(x);
    el.list.appendChild(li);
  });
}

/* ---------- meter, status, log ---------- */

const db = (v) => (20 * Math.log10(Math.max(v, 1e-7))).toFixed(0);

function drawMeter(d) {
  const pct = (v) => Math.max(0, Math.min(100, (20 * Math.log10(Math.max(v, 1e-7)) + 70) / 70 * 100));
  const thr = Math.max(d.floor * (parseFloat(el.ratio.value) || 8), 0.004);
  el.bar.style.width = pct(d.peak) + '%';
  el.bar.classList.toggle('hot', d.peak > thr);
  el.thr.style.left = pct(thr) + '%';
  const lit = Math.round(pct(d.peak) / 20);
  [...el.segs.children].forEach((seg, i) => {
    seg.classList.toggle('on', i < lit);
    seg.classList.toggle('hot', i < lit && d.peak > thr);
  });
  el.lvl.textContent = `${db(d.peak)} dBFS`;
  el.floorTxt.textContent = `floor ${db(d.floor)} · trigger ${db(thr)}`;
}

function setStatus(s, text) {
  el.status.dataset.s = s;
  el.status.textContent = text;
  const live = s === 'listening' || s === 'flight';
  el.panelLive.textContent = { listening: 'LIVE', flight: 'SHOT', error: 'ERR' }[s]
    || (text === 'WAIT' ? 'WAIT' : (shots.length ? 'DONE' : 'OFF'));
  el.panelLive.dataset.live = live ? '1' : '0';
}

function log(line) {
  logLines.push(line);
  if (logLines.length > 60) logLines.shift();
  el.log.textContent = logLines.join('\n');
  el.log.scrollTop = el.log.scrollHeight;
}

let toastTimer = null;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2200);
}

/* ---------- wiring ---------- */

el.go.onclick = () => (mode === 'off' ? start() : stop());

el.micseg.onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  micMode = b.dataset.mic;
  [...el.micseg.children].forEach(c => c.setAttribute('aria-pressed', String(c === b)));
  el.customwrap.hidden = micMode !== 'custom';
  el.michint.textContent = micMode === 'half'
    ? 'Best accuracy: the two sound paths cancel, so temperature stops mattering.'
    : micMode === '0'
      ? 'Simplest setup. Sound has to travel back from the target, so temperature matters.'
      : 'Measure the phone-to-bow distance in the same unit as the target distance.';
  render(); saveSettings();
};

['dist','dunit','micd','temp','wind','sunit','weight','vmin','vmax','offset','drag']
  .forEach(k => el[k].oninput = () => { render(); saveSettings(); });
['ratio','hp'].forEach(k => el[k].oninput = () => { pushParams(); saveSettings(); });

el.clear.onclick = () => {
  if (!shots.length) return;
  shots = []; render(); saveSettings(); toast('Shots cleared');
};

el.csv.onclick = () => {
  if (!shots.length) return toast('Nothing to export');
  const c = cfg();
  const rows = [['n', 'timestamp', 'gap_ms', 'flight_ms', 'avg_' + el.sunit.value, 'distance_m', 'mic_m', 'temp_C', 'wind_ms']];
  shots.forEach((s, i) => {
    const r = solve(s.dt, c);
    rows.push([i + 1, new Date(s.t).toISOString(), (s.dt * 1000).toFixed(2),
      r ? (r.T * 1000).toFixed(2) : '', r ? toUnit(r.vAvg).toFixed(2) : '',
      c.D.toFixed(3), c.m.toFixed(3), el.temp.value, el.wind.value]);
  });
  const blob = new Blob([rows.map(r => r.join(',')).join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `arrow-chrono-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && mode !== 'off' && !wakeLock) {
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
  }
});

loadSettings();
[...el.micseg.children].forEach(c => c.setAttribute('aria-pressed', String(c.dataset.mic === micMode)));
el.customwrap.hidden = micMode !== 'custom';
render();

/* ---------- service worker updates ----------
 * The new worker installs quietly and waits. We surface a prompt, and only
 * when the user accepts do we tell it to take over — which fires
 * controllerchange, which reloads the page onto the new version.
 */

if ('serviceWorker' in navigator) {
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;          // guard: this event can fire more than once
    reloading = true;
    location.reload();
  });

  addEventListener('load', async () => {
    let reg;
    try { reg = await navigator.serviceWorker.register('sw.js'); }
    catch (e) { return; }

    const offer = (worker) => {
      el.updateMsg.textContent = mode === 'off'
        ? 'New version ready'
        : 'New version ready — reloading stops listening';
      el.updateBtn.onclick = () => {
        el.update.classList.remove('show');
        stop();                     // release the mic and wake lock cleanly
        worker.postMessage({ type: 'SKIP_WAITING' });
      };
      el.updateDismiss.onclick = () => el.update.classList.remove('show');
      el.update.classList.add('show');
    };

    // A worker may already be waiting from a previous visit.
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);

    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (!w) return;
      w.addEventListener('statechange', () => {
        // No existing controller means this is the very first install,
        // not an update — nothing to prompt about.
        if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w);
      });
    });

    const check = () => reg.update().catch(() => {});
    setInterval(check, 30 * 60 * 1000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') check();
    });
  });
}
