/* Onset detector. Runs on the audio thread so timing comes from the sample
   clock, not from wall-clock timers. Every onset is reported as an absolute
   sample index, which at 48 kHz gives ~21 microseconds of resolution. */

class OnsetProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sr = sampleRate;
    this.n = 0;

    this.env = 0;
    this.floor = 1e-4;
    this.hold = 0;
    this.peak = 0;
    this.pending = null;

    // Envelope decay: fast enough to separate close transients, slow enough
    // that a single cycle of a low-frequency rumble doesn't look like an onset.
    this.rel = Math.exp(-1 / (0.004 * this.sr));

    // Noise floor tracker: rises slowly (so a bang doesn't raise its own
    // threshold), falls quickly (so it recovers after a gust of wind).
    this.floorUp = 1 - Math.exp(-1 / (1.5 * this.sr));
    this.floorDn = 1 - Math.exp(-1 / (0.08 * this.sr));

    this.ratio = 8;        // trigger at floor * ratio
    this.absMin = 0.004;   // ...but never below this absolute level
    this.holdN = Math.round(0.03 * this.sr);

    // After an event the detector will not re-arm until the envelope has
    // fallen back below releaseFrac x threshold. Without this, a sound that
    // stays loud for longer than the hold re-triggers over and over at exactly
    // the hold interval, and those repeats can mask the real next event.
    this.releaseFrac = 0.5;
    this.waitRelease = false;
    this.waitN = 0;
    this.waitMaxN = Math.round(0.5 * this.sr);   // safety cap

    this.meterN = Math.round(0.05 * this.sr);
    this.meterCount = this.meterN;
    this.meterPeak = 0;

    this.setHighpass(750);

    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.ratio != null) this.ratio = d.ratio;
      if (d.absMin != null) this.absMin = d.absMin;
      if (d.holdMs != null) this.holdN = Math.round((d.holdMs / 1000) * this.sr);
      if (d.hpHz != null) this.setHighpass(d.hpHz);
      if (d.releaseFrac != null) this.releaseFrac = d.releaseFrac;
      if (d.reset) {
        this.env = 0; this.floor = 1e-4; this.hold = 0;
        this.pending = null; this.waitRelease = false;
      }
    };
  }

  /* RBJ biquad high-pass, Q = 0.707. Kills wind rumble, handling noise and
     traffic, which is where nearly all false triggers come from. */
  setHighpass(f) {
    const w = (2 * Math.PI * f) / this.sr;
    const cw = Math.cos(w), sw = Math.sin(w);
    const alpha = sw / (2 * 0.70710678);
    const a0 = 1 + alpha;
    this.b0 = ((1 + cw) / 2) / a0;
    this.b1 = (-(1 + cw)) / a0;
    this.b2 = ((1 + cw) / 2) / a0;
    this.a1 = (-2 * cw) / a0;
    this.a2 = (1 - alpha) / a0;
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;

    for (let i = 0; i < ch.length; i++) {
      const x = ch[i];
      const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2
              - this.a1 * this.y1 - this.a2 * this.y2;
      this.x2 = this.x1; this.x1 = x;
      this.y2 = this.y1; this.y1 = y;

      const a = y < 0 ? -y : y;
      this.env = a > this.env ? a : this.env * this.rel;
      if (this.env > this.meterPeak) this.meterPeak = this.env;

      if (this.hold > 0) {
        // Inside an event: keep the loudest level seen, don't re-trigger,
        // and don't let the event contaminate the noise floor.
        if (this.env > this.peak) this.peak = this.env;
        if (--this.hold === 0 && this.pending !== null) {
          this.port.postMessage({
            t: 'onset', sample: this.pending, peak: this.peak, floor: this.floor
          });
          this.pending = null;
          this.waitRelease = true;      // gate closed until the sound decays
          this.waitN = 0;
        }
      } else if (this.waitRelease) {
        // Hold the noise floor still while a loud event rings out, otherwise
        // the decay tail drags the floor up and desensitises the detector.
        const rel = Math.max(this.floor * this.ratio, this.absMin) * this.releaseFrac;
        if (this.env < rel || ++this.waitN > this.waitMaxN) this.waitRelease = false;
      } else {
        const d = this.env - this.floor;
        this.floor += d > 0 ? d * this.floorUp : d * this.floorDn;

        const thr = Math.max(this.floor * this.ratio, this.absMin);
        if (this.env > thr) {
          this.pending = this.n + i;   // exact sample of the threshold crossing
          this.peak = this.env;
          this.hold = this.holdN;
        }
      }

      if (--this.meterCount <= 0) {
        this.meterCount = this.meterN;
        this.port.postMessage({ t: 'level', peak: this.meterPeak, floor: this.floor });
        this.meterPeak = 0;
      }
    }

    this.n += ch.length;
    return true;
  }
}

registerProcessor('onset-processor', OnsetProcessor);
