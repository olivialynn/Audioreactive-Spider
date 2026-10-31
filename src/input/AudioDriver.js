/**
 * AudioDriver — microphone -> Web Audio FFT -> ControlBus.
 *
 * Continuous bands (bass/mid/treble) come out smoothed for wobble/bob. Beats are
 * trickier from a room mic, so there are layered fallbacks for when automatic
 * detection struggles:
 *
 *   beatSource = 'bass' | 'mid' | 'treble'
 *       Energy-based onset detection on that one band.
 *   beatSource = 'auto'
 *       Picks whichever band is "pumping" most — the one whose energy spikes
 *       highest above its own running average — and follows it. Good when, say,
 *       the kick is weak but the snare/mids are driving the groove.
 *   useTapTempo = true
 *       Ignores onset detection entirely and emits beats on a metronome locked
 *       to your taps (tap() / press T). The manual override.
 *
 * A future MidiDriver would implement the same shape (start() + update(dt)) and
 * write the same ControlBus.
 */
function average(data, start, end) {
  let sum = 0;
  for (let i = start; i < end; i++) sum += data[i];
  return end > start ? sum / (end - start) : 0;
}

export class AudioDriver {
  constructor(bus, opts = {}) {
    this.bus = bus;
    this.fftSize = opts.fftSize ?? 1024;

    this.ctx = null;
    this.analyser = null;
    this.freq = null;
    this.running = false;

    // --- tunable (see ui/Panel.js) ---
    this.sensitivity = opts.sensitivity ?? 1.4; // onset threshold = running avg * this
    this.smoothing = opts.smoothing ?? 0.2;     // band smoothing time constant (seconds)
    this.beatSource = opts.beatSource ?? 'auto'; // 'auto' | 'bass' | 'mid' | 'treble'
    this.useTapTempo = opts.useTapTempo ?? false;

    // --- read-outs (shown in the panel) ---
    this.bpm = 0;
    this.autoBand = '-'; // which band 'auto' is currently following

    // --- per-band detection state ---
    this._bands = ['bass', 'mid', 'treble'];
    this._historySize = 60;       // ~1s of frames
    this._minBeatInterval = 0.12; // refractory (s)
    this._hist = { bass: [], mid: [], treble: [] };
    this._lastBeat = { bass: -1, mid: -1, treble: -1 };
    this._beatiness = { bass: 0, mid: 0, treble: 0 }; // slow EMA of spike size
    this._smoothBands = { bass: 0, mid: 0, treble: 0 };

    // --- tap-tempo metronome state ---
    this._taps = [];
    this._tapPeriod = 0;      // seconds per beat
    this._tapPhaseRef = 0;    // time of the beat we're phase-aligned to
    this._prevTapPhase = 0;
    this._forceBeat = false;  // a tap fires one beat immediately for feedback

    this._time = 0;
  }

  async start() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    const source = this.ctx.createMediaStreamSource(stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = this.fftSize;
    this.analyser.smoothingTimeConstant = 0.6;
    source.connect(this.analyser);

    this.freq = new Uint8Array(this.analyser.frequencyBinCount);
    this.running = true;
  }

  /** Register a tap. Two+ taps set the tempo and switch to tap mode. */
  tap() {
    const t = this._time;
    this._taps.push(t);
    if (this._taps.length > 6) this._taps.shift();

    if (this._taps.length >= 2) {
      let sum = 0;
      for (let i = 1; i < this._taps.length; i++) sum += this._taps[i] - this._taps[i - 1];
      const period = sum / (this._taps.length - 1);
      if (period > 0.2 && period < 2.0) { // 30..300 BPM
        this._tapPeriod = period;
        this._tapPhaseRef = t;     // align a beat to this tap
        this._prevTapPhase = 0;
        this.bpm = Math.round(60 / period);
        this.useTapTempo = true;   // taps imply you want manual tempo
      }
    }
    this._forceBeat = true; // immediate feedback on the tap itself
  }

  update(dt) {
    if (!this.running) return;
    this._time += dt;

    this.analyser.getByteFrequencyData(this.freq);
    const bins = this.freq.length;
    const bassEnd = Math.max(1, Math.floor(bins * 0.08));
    const midEnd = Math.floor(bins * 0.4);
    const raw = {
      bass: average(this.freq, 0, bassEnd) / 255,
      mid: average(this.freq, bassEnd, midEnd) / 255,
      treble: average(this.freq, midEnd, bins) / 255,
    };

    // Smooth the bands for calm continuous motion, and publish them.
    // Frame-rate-independent smoothing: `smoothing` is a time constant in seconds.
    const a = this.smoothing > 1e-4 ? 1 - Math.exp(-dt / this.smoothing) : 1;
    for (const b of this._bands) {
      this._smoothBands[b] += (raw[b] - this._smoothBands[b]) * a;
      this.bus.bands[b] = this._smoothBands[b];
    }
    this.bus.level = (this._smoothBands.bass + this._smoothBands.mid + this._smoothBands.treble) / 3;
    this.bus.time = this._time;

    // Run onset detection + a "beatiness" estimate for every band.
    const detected = {};
    for (const b of this._bands) detected[b] = this._detectBand(b, raw[b]);

    // Resolve the active band (auto picks the most-pumping one). This drives both
    // beat onset AND the continuous bob, so the bob follows whatever you're
    // reacting to — not always bass.
    let src = this.beatSource;
    if (src === 'auto') {
      src = this._bands.reduce((best, b) => (this._beatiness[b] > this._beatiness[best] ? b : best), 'bass');
    }
    this.autoBand = src;
    this.bus.activeBand = src;

    // Decide the beat.
    this.bus.beat = false;
    if (this._forceBeat) {
      this.bus.beat = true;
      this.bus.beatEnergy = 0.8;
      this._forceBeat = false;
    } else if (this.useTapTempo && this._tapPeriod > 0) {
      // Metronome: fire when we cross into a new beat period.
      const phase = (this._time - this._tapPhaseRef) / this._tapPeriod;
      if (Math.floor(phase) > Math.floor(this._prevTapPhase)) {
        this.bus.beat = true;
        this.bus.beatEnergy = 0.8;
      }
      this._prevTapPhase = phase;
    } else {
      const r = detected[src];
      if (r.onset) {
        this.bus.beat = true;
        this.bus.beatEnergy = Math.min(1, r.avg > 1e-6 ? (r.energy / r.avg) / 4 : 0.5);
      }
    }
  }

  /** Energy-based onset detection for one band + a slow spike-size estimate. */
  _detectBand(name, value) {
    const energy = value * value;
    const hist = this._hist[name];
    const avg = hist.length ? hist.reduce((s, v) => s + v, 0) / hist.length : 0;

    // "beatiness": slow EMA of how far each frame spikes above the local average.
    // A steadily-pumping band scores high; a flat one scores ~0.
    const excess = avg > 1e-6 ? Math.max(0, energy / avg - 1) : 0;
    this._beatiness[name] += (excess - this._beatiness[name]) * 0.03;

    let onset = false;
    if (
      hist.length >= this._historySize &&
      energy > avg * this.sensitivity &&
      energy > 0.004 &&
      this._time - this._lastBeat[name] > this._minBeatInterval
    ) {
      onset = true;
      this._lastBeat[name] = this._time;
    }

    hist.push(energy);
    if (hist.length > this._historySize) hist.shift();
    return { onset, energy, avg };
  }
}
