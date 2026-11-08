// Procedural sound: a wind and drone bed, the node hum, the hunter's
// heartbeat and drone, footsteps, and short stings. No audio files.

export type Audio = ReturnType<typeof createAudio>;

type Output = { ctx: AudioContext; master: GainNode; hum: GainNode; menace: GainNode };

export function createAudio() {
  let out: Output | undefined;
  let muted = false;
  let nextBeat = 0;

  const live = () => {
    if (out && out.ctx.state === "suspended") void out.ctx.resume();
    return out;
  };

  const noise = (ctx: AudioContext, seconds: number) => {
    const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  };

  const filter = (ctx: AudioContext, type: BiquadFilterType, frequency: number, q = 1) => {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = frequency;
    f.Q.value = q;
    return f;
  };

  /** A noise burst through a filter with a decaying envelope. */
  const burst = (duration: number, gain: number, type: BiquadFilterType, frequency: number) => {
    const o = live();
    if (!o) return;
    const { ctx, master } = o;
    const src = ctx.createBufferSource();
    src.buffer = noise(ctx, duration);
    const env = ctx.createGain();
    env.gain.setValueAtTime(gain, ctx.currentTime);
    env.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    src.connect(filter(ctx, type, frequency)).connect(env).connect(master);
    src.start();
    src.stop(ctx.currentTime + duration);
  };

  /** A tone sliding between two pitches while it fades out. */
  const slide = (type: OscillatorType, from: number, to: number, duration: number, gain: number) => {
    const o = live();
    if (!o) return;
    const { ctx, master } = o;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(to, ctx.currentTime + duration);
    const env = ctx.createGain();
    env.gain.setValueAtTime(gain, ctx.currentTime);
    env.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.connect(env).connect(master);
    osc.start();
    osc.stop(ctx.currentTime + duration);
  };

  const startBed = (ctx: AudioContext, master: GainNode): Output => {
    const wind = ctx.createBufferSource();
    wind.buffer = noise(ctx, 5);
    wind.loop = true;
    const windGain = ctx.createGain();
    windGain.gain.value = 0.35;
    wind.connect(filter(ctx, "lowpass", 160)).connect(windGain).connect(master);
    wind.start();

    const drone = ctx.createOscillator();
    drone.frequency.value = 41;
    const droneGain = ctx.createGain();
    droneGain.gain.value = 0.05;
    const wobble = ctx.createOscillator();
    wobble.frequency.value = 0.07;
    const wobbleDepth = ctx.createGain();
    wobbleDepth.gain.value = 0.03;
    wobble.connect(wobbleDepth).connect(droneGain.gain);
    drone.connect(droneGain).connect(master);
    drone.start();
    wobble.start();

    // Mains hum, louder near a powered node.
    const hum = ctx.createGain();
    hum.gain.value = 0;
    const humFilter = filter(ctx, "lowpass", 420);
    const humVoices: [number, OscillatorType][] = [
      [60, "sawtooth"],
      [120, "triangle"],
      [180, "sine"],
    ];
    for (const [frequency, type] of humVoices) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = frequency;
      osc.connect(humFilter);
      osc.start();
    }
    humFilter.connect(hum).connect(master);

    // A detuned growl that rises with the hunter's closeness.
    const menace = ctx.createGain();
    menace.gain.value = 0;
    const menaceFilter = filter(ctx, "lowpass", 300, 4);
    for (const frequency of [55, 55.9, 82.4]) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = frequency;
      osc.connect(menaceFilter);
      osc.start();
    }
    menaceFilter.connect(menace).connect(master);
    return { ctx, master, hum, menace };
  };

  return {
    /** Call from a user gesture. Creates the context and starts the bed. */
    unlock() {
      if (out) {
        void out.ctx.resume();
        return;
      }
      const ctx = new AudioContext();
      const master = ctx.createGain();
      master.gain.value = muted ? 0 : 1;
      master.connect(ctx.destination);
      out = startBed(ctx, master);
    },
    setMuted(value: boolean) {
      muted = value;
      if (out) out.master.gain.setTargetAtTime(value ? 0 : 1, out.ctx.currentTime, 0.05);
    },
    /** Once per frame. Both levels run 0 to 1. */
    update(dt: number, levels: { hum: number; danger: number }) {
      const o = live();
      if (!o) return;
      const now = o.ctx.currentTime;
      o.hum.gain.setTargetAtTime(0.14 * levels.hum, now, 0.15);
      o.menace.gain.setTargetAtTime(0.16 * levels.danger * levels.danger, now, 0.2);
      nextBeat -= dt;
      if (levels.danger > 0.08 && nextBeat <= 0) {
        slide("sine", 58, 38, 0.22, 0.12 + 0.4 * levels.danger);
        nextBeat = 1.15 - 0.8 * levels.danger;
      }
    },
    step(sprinting: boolean) {
      burst(0.08, sprinting ? 0.3 : 0.16, "bandpass", sprinting ? 420 : 320);
    },
    click() {
      burst(0.025, 0.25, "highpass", 2500);
    },
    shutdown() {
      slide("sawtooth", 160, 26, 1.6, 0.28);
      burst(0.5, 0.25, "lowpass", 900);
    },
    spotted() {
      slide("sawtooth", 70, 210, 0.7, 0.22);
      slide("square", 140, 420, 0.5, 0.06);
    },
    caught() {
      burst(1.4, 0.7, "lowpass", 1400);
      slide("sine", 70, 18, 1.8, 0.6);
    },
    won() {
      const o = live();
      if (!o) return;
      const { ctx, master, hum } = o;
      hum.gain.setTargetAtTime(0, ctx.currentTime, 0.3);
      [220, 277.2, 329.6, 440].forEach((frequency, i) => {
        const osc = ctx.createOscillator();
        osc.frequency.value = frequency;
        const env = ctx.createGain();
        env.gain.setValueAtTime(0.0001, ctx.currentTime);
        env.gain.exponentialRampToValueAtTime(0.07, ctx.currentTime + 1.5 + i * 0.4);
        env.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 6);
        osc.connect(env).connect(master);
        osc.start();
        osc.stop(ctx.currentTime + 6);
      });
    },
  };
}
