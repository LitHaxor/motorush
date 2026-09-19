// All sound is synthesised in the browser - no audio files to download.
//
// The engine is a pair of detuned saws through a low-pass whose cutoff and
// pitch track the revs, with a separate noise bed for wind and tyre roar.

import { clamp } from '../sim/mathx';
import { BIKE } from '../sim/config';
import type { SimEvent } from '../sim/types';

const GEARS = 6;

function noiseBuffer(ctx: AudioContext, seconds = 2): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

export class GameAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;

  private engineGain: GainNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private osc1: OscillatorNode | null = null;
  private osc2: OscillatorNode | null = null;
  private sub: OscillatorNode | null = null;

  private windGain: GainNode | null = null;
  private sirenOsc: OscillatorNode | null = null;
  private sirenGain: GainNode | null = null;

  private started = false;
  private muted = false;
  private volume = 0.75;

  get isMuted(): boolean {
    return this.muted;
  }

  /** Must be called from a user gesture or the browser will not allow audio. */
  async start(): Promise<void> {
    if (this.started) {
      await this.ctx?.resume();
      return;
    }
    type WindowWithWebkit = Window & { webkitAudioContext?: typeof AudioContext };
    const Ctor = window.AudioContext ?? (window as WindowWithWebkit).webkitAudioContext;
    if (!Ctor) return;

    const ctx = new Ctor();
    this.ctx = ctx;
    this.noise = noiseBuffer(ctx);

    const master = ctx.createGain();
    master.gain.value = this.muted ? 0 : this.volume;
    master.connect(ctx.destination);
    this.master = master;

    // --- engine -------------------------------------------------------
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 600;
    filter.Q.value = 6;

    const gain = ctx.createGain();
    gain.gain.value = 0;
    filter.connect(gain);
    gain.connect(master);
    this.engineFilter = filter;
    this.engineGain = gain;

    const mkOsc = (type: OscillatorType, detune: number): OscillatorNode => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = 80;
      o.detune.value = detune;
      o.connect(filter);
      o.start();
      return o;
    };
    this.osc1 = mkOsc('sawtooth', -7);
    this.osc2 = mkOsc('sawtooth', 9);
    this.sub = mkOsc('square', 0);

    // --- wind / tyre bed ------------------------------------------------
    const wind = ctx.createBufferSource();
    wind.buffer = this.noise;
    wind.loop = true;
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'bandpass';
    windFilter.frequency.value = 900;
    windFilter.Q.value = 0.7;
    const windGain = ctx.createGain();
    windGain.gain.value = 0;
    wind.connect(windFilter);
    windFilter.connect(windGain);
    windGain.connect(master);
    wind.start();
    this.windGain = windGain;

    // --- police siren (idle until a cop shows up) -------------------------
    const siren = ctx.createOscillator();
    siren.type = 'sine';
    siren.frequency.value = 700;
    const sirenGain = ctx.createGain();
    sirenGain.gain.value = 0;
    siren.connect(sirenGain);
    sirenGain.connect(master);
    siren.start();
    this.sirenOsc = siren;
    this.sirenGain = sirenGain;

    this.started = true;
    await ctx.resume();
    this.nudge(ctx);
  }

  /**
   * Push a moment of silence through the graph.
   *
   * Mobile browsers will happily report a running context and still produce
   * nothing until something has actually been played from inside a gesture.
   * A one-sample silent buffer is the cheapest way to satisfy that.
   */
  private nudge(ctx: AudioContext): void {
    try {
      const buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start(0);
    } catch {
      /* nothing to lose if it is refused */
    }
  }

  /**
   * Bring the sound back after the tab has been away.
   *
   * Phones suspend the context when you switch apps or lock the screen, and
   * it does not come back on its own - the race returns in silence.
   */
  async resume(): Promise<void> {
    if (!this.started || !this.ctx) return;
    if (this.ctx.state === 'running') return;
    try {
      await this.ctx.resume();
    } catch {
      /* it will be tried again on the next interaction */
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(muted ? 0 : this.volume, this.ctx.currentTime, 0.05);
    }
  }

  toggleMute(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  /**
   * Per-frame engine state.
   * `throttle` 0..1, `speed` in m/s, `riding` false while crashed.
   */
  update(speed: number, throttle: number, riding: boolean, copDistance: number | null): void {
    const ctx = this.ctx;
    if (!ctx || !this.engineGain || !this.engineFilter) return;
    const now = ctx.currentTime;
    const t = 0.05;

    const norm = clamp(speed / BIKE.maxSpeed, 0, 1);
    // Fake a gearbox so acceleration sounds like it is shifting up.
    const geared = norm * GEARS;
    const inGear = geared - Math.floor(geared);
    const revs = 0.25 + inGear * 0.75;
    const base = 58 + revs * 132 + norm * 26;

    this.osc1?.frequency.setTargetAtTime(base, now, t);
    this.osc2?.frequency.setTargetAtTime(base * 1.005, now, t);
    this.sub?.frequency.setTargetAtTime(base * 0.5, now, t);

    this.engineFilter.frequency.setTargetAtTime(
      420 + revs * 1500 + throttle * 700,
      now,
      t,
    );
    const loudness = riding ? 0.1 + throttle * 0.11 + norm * 0.06 : 0.02;
    this.engineGain.gain.setTargetAtTime(loudness, now, t);
    this.windGain?.gain.setTargetAtTime(riding ? norm * norm * 0.1 : 0.01, now, t);

    // Siren rises as the cop closes in.
    if (this.sirenGain && this.sirenOsc) {
      if (copDistance == null) {
        this.sirenGain.gain.setTargetAtTime(0, now, 0.3);
      } else {
        const near = clamp(1 - copDistance / 140, 0, 1);
        this.sirenGain.gain.setTargetAtTime(near * 0.06, now, 0.2);
        const wail = Math.sin(now * 5) > 0 ? 760 : 560;
        this.sirenOsc.frequency.setTargetAtTime(wail, now, 0.05);
      }
    }
  }

  // ------------------------------------------------------------- one-shots
  private burst(
    { freq = 200, dur = 0.2, type = 'noise', gain = 0.3, sweep = 0, filter = 1200, q = 1 }:
    { freq?: number; dur?: number; type?: 'noise' | OscillatorType; gain?: number; sweep?: number; filter?: number; q?: number },
  ): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const now = ctx.currentTime;

    const env = ctx.createGain();
    env.gain.setValueAtTime(gain, now);
    env.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    env.connect(this.master);

    if (type === 'noise') {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      const bq = ctx.createBiquadFilter();
      bq.type = 'lowpass';
      bq.frequency.setValueAtTime(filter, now);
      bq.Q.value = q;
      if (sweep) bq.frequency.exponentialRampToValueAtTime(Math.max(60, filter + sweep), now + dur);
      src.connect(bq);
      bq.connect(env);
      src.start(now);
      src.stop(now + dur);
    } else {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, now);
      if (sweep) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + sweep), now + dur);
      osc.connect(env);
      osc.start(now);
      osc.stop(now + dur);
    }
  }

  crash(): void {
    this.burst({ type: 'noise', dur: 0.55, gain: 0.45, filter: 2600, sweep: -2300, q: 2 });
    this.burst({ type: 'sine', freq: 90, sweep: -55, dur: 0.4, gain: 0.35 });
  }

  scrape(): void {
    this.burst({ type: 'noise', dur: 0.22, gain: 0.18, filter: 3200, sweep: -1800, q: 4 });
  }

  punch(): void {
    this.burst({ type: 'noise', dur: 0.12, gain: 0.3, filter: 1500, sweep: -1100, q: 2 });
    this.burst({ type: 'sine', freq: 150, sweep: -90, dur: 0.14, gain: 0.3 });
  }

  club(): void {
    this.burst({ type: 'noise', dur: 0.18, gain: 0.38, filter: 900, sweep: -600, q: 3 });
    this.burst({ type: 'triangle', freq: 110, sweep: -60, dur: 0.22, gain: 0.32 });
  }

  whiff(): void {
    this.burst({ type: 'noise', dur: 0.14, gain: 0.1, filter: 2400, sweep: 900, q: 6 });
  }

  pickup(): void {
    this.burst({ type: 'sine', freq: 660, sweep: 440, dur: 0.12, gain: 0.22 });
    window.setTimeout(() => this.burst({ type: 'sine', freq: 990, dur: 0.16, gain: 0.2 }), 90);
  }

  beep(high = false): void {
    this.burst({ type: 'square', freq: high ? 980 : 620, dur: high ? 0.35 : 0.14, gain: 0.16 });
  }

  /** Comedy "oof" for flattening a pedestrian. */
  oof(): void {
    this.burst({ type: 'sawtooth', freq: 420, sweep: -300, dur: 0.28, gain: 0.2 });
    this.burst({ type: 'noise', dur: 0.16, gain: 0.14, filter: 1100, sweep: -700, q: 2 });
  }

  bust(): void {
    this.burst({ type: 'sawtooth', freq: 320, sweep: -240, dur: 0.9, gain: 0.3 });
  }

  fanfare(): void {
    [0, 140, 280, 460].forEach((delay, i) => {
      window.setTimeout(
        () => this.burst({ type: 'square', freq: [523, 659, 784, 1047][i], dur: 0.3, gain: 0.18 }),
        delay,
      );
    });
  }

  /** Route simulation events to one-shots. */
  handleEvents(events: readonly SimEvent[], playerId: number): void {
    if (!this.started) return;
    for (const e of events) {
      switch (e.type) {
        case 'crash':
          if (e.racer.id === playerId) this.crash();
          break;
        case 'scrape':
          if (e.racer.id === playerId) this.scrape();
          break;
        case 'hit':
          if (e.attacker.id === playerId || e.victim.id === playerId) {
            if (e.weapon === 'fist') this.punch();
            else this.club();
          }
          break;
        case 'whiff':
          if (e.attacker.id === playerId) this.whiff();
          break;
        case 'pickup':
          if (e.racer.id === playerId) this.pickup();
          break;
        case 'pedestrianHit':
          if (e.racer.id === playerId) this.oof();
          break;
        case 'countdown':
          this.beep(e.value === 0);
          break;
        case 'raceEnd':
          if (e.reason === 'busted') this.bust();
          else if (e.reason === 'finished' && e.result.place === 1) this.fanfare();
          else if (e.reason === 'wasted') this.bust();
          break;
        default:
          break;
      }
    }
  }

  dispose(): void {
    this.ctx?.close();
    this.ctx = null;
    this.started = false;
  }
}
