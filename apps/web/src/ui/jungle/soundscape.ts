import { useSyncExternalStore } from 'react';

/* A deep-forest soundscape synthesized live with the Web Audio API. Nothing is downloaded.

   - Bed: a low, slightly uneasy drone; a stream; rustling leaves; distant crickets.
   - Near calls: birdsong (tweets, warbles, a dove) every few seconds.
   - Far calls, through a generated reverb: woodpeckers, cicada swells, frog choruses,
     howler monkeys, owls, water drips and a strange whooping bird.
   - Voices for each animal, and soft leaf ticks for the interface.

   Ambient sound starts only from a user gesture (the toggle); the choice to mute is
   remembered, and muting silences the animals too. */

export type Critter = 'monkey' | 'toucan' | 'sloth' | 'frog' | 'owl' | 'butterfly' | 'jaguar';

const PREF_KEY = 'ff-forest-sound';

type Listener = () => void;

interface Engine {
  readonly ctx: AudioContext;
  readonly out: GainNode;
  /** A send into the reverb, for distant sounds. */
  readonly far: GainNode;
}

let engine: Engine | null = null;
let ambient: { stop: () => void } | null = null;
let nearTimer: ReturnType<typeof setTimeout> | undefined;
let farTimer: ReturnType<typeof setTimeout> | undefined;
let enabled = false;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function readMuted(): boolean {
  try {
    return window.localStorage.getItem(PREF_KEY) === 'off';
  } catch {
    return false;
  }
}

function writePref(value: 'on' | 'off'): void {
  try {
    window.localStorage.setItem(PREF_KEY, value);
  } catch {
    // A remembered preference is only a convenience.
  }
}

/** A decaying-noise impulse response: the reverb of a big, damp forest. */
function forestImpulse(ctx: AudioContext): AudioBuffer {
  const seconds = 3.2;
  const length = Math.floor(ctx.sampleRate * seconds);
  const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let channel = 0; channel < 2; channel += 1) {
    const data = impulse.getChannelData(channel);
    for (let index = 0; index < length; index += 1) {
      data[index] = (Math.random() * 2 - 1) * (1 - index / length) ** 3;
    }
  }
  return impulse;
}

function audio(): Engine | null {
  if (typeof window === 'undefined' || typeof window.AudioContext !== 'function') {
    return null;
  }
  if (engine === null) {
    const ctx = new window.AudioContext();
    const out = ctx.createGain();
    out.gain.value = 0.9;
    out.connect(ctx.destination);
    const reverb = ctx.createConvolver();
    reverb.buffer = forestImpulse(ctx);
    const reverbOut = ctx.createGain();
    reverbOut.gain.value = 0.7;
    const far = ctx.createGain();
    // Far sounds lose their highs.
    const air = ctx.createBiquadFilter();
    air.type = 'lowpass';
    air.frequency.value = 3200;
    far.connect(air).connect(reverb).connect(reverbOut).connect(out);
    engine = { ctx, out, far };
  }
  if (engine.ctx.state === 'suspended') {
    void engine.ctx.resume();
  }
  return engine;
}

function noiseBuffer(ctx: AudioContext, brown: boolean): AudioBuffer {
  const length = ctx.sampleRate * 3;
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  for (let index = 0; index < length; index += 1) {
    const white = Math.random() * 2 - 1;
    if (brown) {
      last = (last + 0.02 * white) / 1.02;
      data[index] = last * 3.5;
    } else {
      data[index] = white;
    }
  }
  return buffer;
}

function envelope(
  gain: GainNode,
  start: number,
  peak: number,
  attack: number,
  hold: number,
  release: number,
): void {
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), start + attack);
  gain.gain.setValueAtTime(Math.max(0.0002, peak), start + attack + hold);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + attack + hold + release);
}

function panned(ctx: AudioContext, destination: AudioNode, pan: number): StereoPannerNode {
  const node = ctx.createStereoPanner();
  node.pan.value = pan;
  node.connect(destination);
  return node;
}

/** One tone with a pitch glide and an envelope. */
function tone(
  ctx: AudioContext,
  destination: AudioNode,
  options: {
    type: OscillatorType;
    from: number;
    to: number;
    at: number;
    duration: number;
    peak: number;
    filter?: number;
    vibrato?: { rate: number; depth: number };
  },
): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = options.type;
  osc.frequency.setValueAtTime(options.from, options.at);
  osc.frequency.exponentialRampToValueAtTime(options.to, options.at + options.duration);
  envelope(gain, options.at, options.peak, 0.02, options.duration * 0.5, options.duration * 0.5);
  let source: AudioNode = osc;
  if (options.filter !== undefined) {
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = options.filter;
    source = osc.connect(filter);
  }
  source.connect(gain).connect(destination);
  if (options.vibrato !== undefined) {
    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    lfo.frequency.value = options.vibrato.rate;
    depth.gain.value = options.vibrato.depth;
    lfo.connect(depth).connect(osc.frequency);
    lfo.start(options.at);
    lfo.stop(options.at + options.duration + 0.1);
  }
  osc.start(options.at);
  osc.stop(options.at + options.duration + 0.1);
}

/** A short burst of filtered noise (knocks, drips, rustles). */
function burst(
  ctx: AudioContext,
  destination: AudioNode,
  options: { at: number; duration: number; peak: number; frequency: number; q: number },
): void {
  const source = ctx.createBufferSource();
  source.buffer = noiseBuffer(ctx, false);
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = options.frequency;
  filter.Q.value = options.q;
  const gain = ctx.createGain();
  envelope(gain, options.at, options.peak, 0.003, options.duration * 0.2, options.duration * 0.8);
  source.connect(filter).connect(gain).connect(destination);
  source.start(options.at);
  source.stop(options.at + options.duration + 0.05);
}

function startAmbient({ ctx, out }: Engine): { stop: () => void } {
  const sources: AudioScheduledSourceNode[] = [];

  // The drone: two close low tones beating against each other, slowly filtered.
  const droneFilter = ctx.createBiquadFilter();
  droneFilter.type = 'lowpass';
  droneFilter.frequency.value = 180;
  const droneGain = ctx.createGain();
  droneGain.gain.value = 0.05;
  droneFilter.connect(droneGain).connect(out);
  for (const frequency of [55, 55.6, 82.4]) {
    const osc = ctx.createOscillator();
    osc.type = frequency > 60 ? 'sine' : 'triangle';
    osc.frequency.value = frequency;
    osc.connect(droneFilter);
    sources.push(osc);
  }
  const droneSweep = ctx.createOscillator();
  droneSweep.frequency.value = 0.03;
  const droneSweepDepth = ctx.createGain();
  droneSweepDepth.gain.value = 90;
  droneSweep.connect(droneSweepDepth).connect(droneFilter.frequency);
  sources.push(droneSweep);

  // A stream, swelling slowly.
  const stream = ctx.createBufferSource();
  stream.buffer = noiseBuffer(ctx, true);
  stream.loop = true;
  const streamFilter = ctx.createBiquadFilter();
  streamFilter.type = 'lowpass';
  streamFilter.frequency.value = 650;
  const streamGain = ctx.createGain();
  streamGain.gain.value = 0.05;
  const swell = ctx.createOscillator();
  swell.frequency.value = 0.07;
  const swellDepth = ctx.createGain();
  swellDepth.gain.value = 0.02;
  swell.connect(swellDepth).connect(streamGain.gain);
  stream.connect(streamFilter).connect(streamGain).connect(out);
  sources.push(stream, swell);

  // Leaves: a whisper of band-passed noise.
  const leaves = ctx.createBufferSource();
  leaves.buffer = noiseBuffer(ctx, false);
  leaves.loop = true;
  const leafFilter = ctx.createBiquadFilter();
  leafFilter.type = 'bandpass';
  leafFilter.frequency.value = 3000;
  leafFilter.Q.value = 0.6;
  const leafGain = ctx.createGain();
  leafGain.gain.value = 0.005;
  leaves.connect(leafFilter).connect(leafGain).connect(out);
  sources.push(leaves);

  // Crickets, far off on the left and right.
  for (const [frequency, pan, rate] of [
    [4600, -0.6, 24],
    [5200, 0.7, 31],
  ] as const) {
    const cricket = ctx.createOscillator();
    cricket.frequency.value = frequency;
    const gate = ctx.createGain();
    gate.gain.value = 0;
    const chirp = ctx.createOscillator();
    chirp.type = 'square';
    chirp.frequency.value = rate;
    const depth = ctx.createGain();
    depth.gain.value = 0.003;
    chirp.connect(depth).connect(gate.gain);
    cricket.connect(gate).connect(panned(ctx, out, pan));
    sources.push(cricket, chirp);
  }

  const now = ctx.currentTime;
  for (const source of sources) {
    source.start(now);
  }
  return {
    stop: () => {
      for (const source of sources) {
        try {
          source.stop();
        } catch {
          // Already stopped.
        }
      }
    },
  };
}

/* ------------------------------------------------------------------ near birdsong */

function birdCall({ ctx, out }: Engine): void {
  const pan = panned(ctx, out, Math.random() * 1.6 - 0.8);
  const t = ctx.currentTime + 0.05;
  const kind = Math.floor(Math.random() * 3);
  if (kind === 0) {
    const notes = 3 + Math.floor(Math.random() * 4);
    for (let note = 0; note < notes; note += 1) {
      const at = t + note * 0.11;
      tone(ctx, pan, {
        type: 'sine',
        from: 2300 + Math.random() * 500,
        to: 4200,
        at,
        duration: 0.07,
        peak: 0.04,
      });
    }
  } else if (kind === 1) {
    tone(ctx, pan, {
      type: 'sine',
      from: 2900 + Math.random() * 500,
      to: 3100,
      at: t,
      duration: 0.5,
      peak: 0.03,
      vibrato: { rate: 28, depth: 380 },
    });
  } else {
    [680, 540].forEach((frequency, index) => {
      tone(ctx, pan, {
        type: 'triangle',
        from: frequency,
        to: frequency * 0.94,
        at: t + index * 0.32,
        duration: 0.28,
        peak: 0.04,
      });
    });
  }
}

/* ------------------------------------------------------------------ far calls */

const FAR_CALLS: readonly ((engine: Engine, pan: AudioNode, t: number) => void)[] = [
  // A woodpecker drumming, speeding up.
  ({ ctx }, pan, t) => {
    let at = t;
    let gap = 0.09;
    for (let knock = 0; knock < 12; knock += 1) {
      burst(ctx, pan, { at, duration: 0.03, peak: 0.25, frequency: 1500, q: 6 });
      at += gap;
      gap *= 0.93;
    }
  },
  // A cicada swell.
  ({ ctx }, pan, t) => {
    const source = ctx.createBufferSource();
    source.buffer = noiseBuffer(ctx, false);
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 5200;
    filter.Q.value = 9;
    const gate = ctx.createGain();
    gate.gain.value = 0.5;
    const pulse = ctx.createOscillator();
    pulse.frequency.value = 110;
    const pulseDepth = ctx.createGain();
    pulseDepth.gain.value = 0.5;
    pulse.connect(pulseDepth).connect(gate.gain);
    const gain = ctx.createGain();
    envelope(gain, t, 0.35, 1.4, 1.2, 1.6);
    source.connect(filter).connect(gate).connect(gain).connect(pan);
    source.start(t);
    pulse.start(t);
    source.stop(t + 4.4);
    pulse.stop(t + 4.4);
  },
  // A frog chorus.
  ({ ctx }, pan, t) => {
    for (let croak = 0; croak < 9; croak += 1) {
      const base = 95 + Math.random() * 60;
      tone(ctx, pan, {
        type: 'square',
        from: base,
        to: base * 0.8,
        at: t + croak * 0.18 + Math.random() * 0.1,
        duration: 0.12,
        peak: 0.12,
        filter: 600,
      });
    }
  },
  // A howler monkey, far away: a long, rough roar.
  ({ ctx }, pan, t) => {
    for (let roar = 0; roar < 3; roar += 1) {
      tone(ctx, pan, {
        type: 'sawtooth',
        from: 95,
        to: 140,
        at: t + roar * 0.9,
        duration: 0.8,
        peak: 0.16,
        filter: 450,
        vibrato: { rate: 13, depth: 9 },
      });
    }
  },
  // An owl, two hoots.
  ({ ctx }, pan, t) => {
    [0, 0.55].forEach((offset) => {
      tone(ctx, pan, {
        type: 'sine',
        from: 390,
        to: 350,
        at: t + offset,
        duration: 0.35,
        peak: 0.2,
      });
    });
  },
  // Water dripping from leaves.
  ({ ctx }, pan, t) => {
    for (let drop = 0; drop < 3; drop += 1) {
      tone(ctx, pan, {
        type: 'sine',
        from: 1500 + Math.random() * 600,
        to: 500,
        at: t + drop * (0.4 + Math.random() * 0.6),
        duration: 0.06,
        peak: 0.2,
      });
    }
  },
  // A strange whooping bird: a slow rise and fall, slightly off.
  ({ ctx }, pan, t) => {
    tone(ctx, pan, {
      type: 'sine',
      from: 320,
      to: 880,
      at: t,
      duration: 0.7,
      peak: 0.14,
      vibrato: { rate: 5, depth: 14 },
    });
    tone(ctx, pan, { type: 'sine', from: 880, to: 260, at: t + 0.75, duration: 0.9, peak: 0.12 });
  },
];

function farCall(current: Engine): void {
  const pan = panned(current.ctx, current.far, Math.random() * 1.8 - 0.9);
  const call = FAR_CALLS[Math.floor(Math.random() * FAR_CALLS.length)];
  call?.(current, pan, current.ctx.currentTime + 0.05);
}

function scheduleNear(): void {
  nearTimer = setTimeout(
    () => {
      const current = audio();
      if (current !== null && enabled) {
        birdCall(current);
        scheduleNear();
      }
    },
    2200 + Math.random() * 5000,
  );
}

function scheduleFar(): void {
  farTimer = setTimeout(
    () => {
      const current = audio();
      if (current !== null && enabled) {
        farCall(current);
        scheduleFar();
      }
    },
    4000 + Math.random() * 7000,
  );
}

/* ------------------------------------------------------------------ animal voices */

const VOICES: Record<Critter, (ctx: AudioContext, out: AudioNode, t: number) => void> = {
  monkey: (ctx, out, t) => {
    [0, 0.2, 0.42].forEach((offset, index) => {
      tone(ctx, out, {
        type: 'sawtooth',
        from: 300 + index * 40,
        to: index === 2 ? 680 : 500,
        at: t + offset,
        duration: index === 2 ? 0.3 : 0.16,
        peak: 0.07,
        filter: 1300,
      });
    });
  },
  toucan: (ctx, out, t) => {
    [0, 0.18].forEach((offset) => {
      tone(ctx, out, {
        type: 'sawtooth',
        from: 950,
        to: 620,
        at: t + offset,
        duration: 0.14,
        peak: 0.05,
        filter: 2400,
      });
    });
  },
  sloth: (ctx, out, t) => {
    tone(ctx, out, { type: 'sine', from: 240, to: 140, at: t, duration: 1.2, peak: 0.08 });
  },
  frog: (ctx, out, t) => {
    [0, 0.26].forEach((offset) => {
      tone(ctx, out, {
        type: 'square',
        from: 120,
        to: 90,
        at: t + offset,
        duration: 0.16,
        peak: 0.06,
        filter: 500,
      });
    });
  },
  owl: (ctx, out, t) => {
    [0, 0.5, 0.75].forEach((offset) => {
      tone(ctx, out, {
        type: 'sine',
        from: 400,
        to: 360,
        at: t + offset,
        duration: 0.3,
        peak: 0.07,
      });
    });
  },
  butterfly: (ctx, out, t) => {
    [1320, 1760, 2640].forEach((frequency, index) => {
      tone(ctx, out, {
        type: 'sine',
        from: frequency,
        to: frequency * 1.01,
        at: t + index * 0.09,
        duration: 0.6,
        peak: 0.025,
      });
    });
  },
  jaguar: (ctx, out, t) => {
    // A low growl: rough, rumbling, rising and falling.
    tone(ctx, out, {
      type: 'sawtooth',
      from: 70,
      to: 110,
      at: t,
      duration: 0.9,
      peak: 0.12,
      filter: 380,
      vibrato: { rate: 21, depth: 12 },
    });
    burst(ctx, out, { at: t + 0.05, duration: 0.9, peak: 0.04, frequency: 300, q: 1.2 });
  },
};

/** Plays an animal's voice. `volume` below 1 is used when an animal calls for attention. */
export function playCritter(critter: Critter, volume = 1): void {
  if (readMuted()) {
    return;
  }
  const current = audio();
  if (current === null) {
    return;
  }
  const level = current.ctx.createGain();
  level.gain.value = volume;
  level.connect(current.out);
  VOICES[critter](current.ctx, level, current.ctx.currentTime + 0.02);
}

/** A soft leaf tick for interface hovers; only while the forest is playing. */
export function playLeafTick(): void {
  const current = enabled ? audio() : null;
  if (current === null) {
    return;
  }
  burst(current.ctx, current.out, {
    at: current.ctx.currentTime,
    duration: 0.05,
    peak: 0.05,
    frequency: 2400,
    q: 2,
  });
}

export function isForestOn(): boolean {
  return enabled;
}

export function enableForest(): void {
  const current = audio();
  if (current === null || enabled) {
    return;
  }
  enabled = true;
  writePref('on');
  const now = current.ctx.currentTime;
  current.out.gain.cancelScheduledValues(now);
  current.out.gain.setValueAtTime(0.0001, now);
  current.out.gain.exponentialRampToValueAtTime(0.9, now + 3);
  ambient = startAmbient(current);
  scheduleNear();
  scheduleFar();
  emit();
}

export function disableForest(): void {
  enabled = false;
  writePref('off');
  clearTimeout(nearTimer);
  clearTimeout(farTimer);
  const stopping = ambient;
  ambient = null;
  if (engine !== null) {
    const { ctx, out } = engine;
    const now = ctx.currentTime;
    out.gain.cancelScheduledValues(now);
    out.gain.setValueAtTime(out.gain.value, now);
    out.gain.linearRampToValueAtTime(0.0001, now + 0.8);
    setTimeout(() => {
      stopping?.stop();
      if (!enabled) {
        out.gain.value = 0.9;
      }
    }, 900);
  }
  emit();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether the ambient forest is playing, for the toggle. */
export function useForestSound(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => enabled,
    () => false,
  );
}
