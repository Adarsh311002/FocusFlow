// Focus sounds for Deep Focus (DF5): several synthesized soundscapes that can play together.
// Nothing is downloaded: every sound is generated in the browser with the Web Audio API.
// The chosen set is the truth; audio is best effort (a browser without Web Audio, or a test
// environment, keeps the choice and plays nothing).

export const FOCUS_SOUNDS = [
  { id: 'brown', label: 'Brown noise', hint: 'Deep, even rumble' },
  { id: 'pink', label: 'Pink noise', hint: 'Soft, balanced hiss' },
  { id: 'white', label: 'White noise', hint: 'Bright, masks voices' },
  { id: 'rain', label: 'Rain', hint: 'Steady rain on a roof' },
  { id: 'waves', label: 'Ocean waves', hint: 'Slow swells' },
  { id: 'fire', label: 'Fireplace', hint: 'Warm crackle' },
] as const;

export type FocusSoundId = (typeof FOCUS_SOUNDS)[number]['id'];

const SOUND_IDS: readonly string[] = FOCUS_SOUNDS.map((sound) => sound.id);
const CHOICE_KEY = 'ff-deep-focus-sounds';
const VOLUME_KEY = 'ff-deep-focus-volume';

// ---- The chosen set (what the UI shows) -------------------------------------------------

let selection: readonly FocusSoundId[] = [];
let volume = readVolume();
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeSounds(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The sounds playing now; a stable array between changes (for `useSyncExternalStore`). */
export function playingSounds(): readonly FocusSoundId[] {
  return selection;
}

export function soundVolume(): number {
  return volume;
}

/** The set last chosen on this device, so the next Deep Focus opens with it. */
export function savedSoundChoice(): FocusSoundId[] {
  try {
    const raw = window.localStorage.getItem(CHOICE_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is FocusSoundId => typeof id === 'string' && SOUND_IDS.includes(id))
      : [];
  } catch {
    return [];
  }
}

function saveChoice(ids: readonly FocusSoundId[]): void {
  try {
    window.localStorage.setItem(CHOICE_KEY, JSON.stringify(ids));
  } catch {
    // Not remembered on this device; the sounds still play.
  }
}

function readVolume(): number {
  try {
    const raw = Number(window.localStorage.getItem(VOLUME_KEY) ?? 'NaN');
    return Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0.6;
  } catch {
    return 0.6;
  }
}

/**
 * Plays exactly these sounds, starting the missing ones and fading out the rest. Call it
 * from a click (or key press): browsers only allow audio to start after one.
 */
export function playSounds(ids: readonly FocusSoundId[]): void {
  const next = FOCUS_SOUNDS.map((sound) => sound.id).filter((id) => ids.includes(id));
  for (const id of selection) {
    if (!next.includes(id)) {
      stopVoice(id);
    }
  }
  for (const id of next) {
    if (!selection.includes(id)) {
      startVoice(id);
    }
  }
  if (next.length !== selection.length || next.some((id, index) => id !== selection[index])) {
    selection = next;
    if (next.length > 0) {
      saveChoice(next);
    }
    changed();
  }
}

export function toggleSound(id: FocusSoundId): void {
  playSounds(
    selection.includes(id) ? selection.filter((other) => other !== id) : [...selection, id],
  );
}

/** Stops every sound (the choice stays saved for next time). */
export function stopAllSounds(): void {
  playSounds([]);
}

export function setSoundVolume(next: number): void {
  volume = Math.min(1, Math.max(0, next));
  if (audio !== null) {
    audio.master.gain.setTargetAtTime(volume, audio.ctx.currentTime, 0.05);
  }
  try {
    window.localStorage.setItem(VOLUME_KEY, String(volume));
  } catch {
    // Not remembered.
  }
  changed();
}

// ---- Audio ------------------------------------------------------------------------------

type Voice = { gain: GainNode; sources: AudioScheduledSourceNode[] };

let audio: { ctx: AudioContext; master: GainNode } | null = null;
const voices = new Map<FocusSoundId, Voice>();

function context(): { ctx: AudioContext; master: GainNode } | null {
  if (typeof AudioContext === 'undefined') {
    return null;
  }
  if (audio === null) {
    const ctx = new AudioContext();
    const master = ctx.createGain();
    master.gain.value = volume;
    master.connect(ctx.destination);
    audio = { ctx, master };
  }
  if (audio.ctx.state === 'suspended') {
    void audio.ctx.resume();
  }
  return audio;
}

/** A looping buffer of `seconds` filled by `fill` (one channel). */
function loop(
  ctx: AudioContext,
  seconds: number,
  fill: (data: Float32Array, rate: number) => void,
) {
  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  fill(buffer.getChannelData(0), ctx.sampleRate);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  return source;
}

const white = (data: Float32Array): void => {
  for (let index = 0; index < data.length; index += 1) {
    data[index] = Math.random() * 2 - 1;
  }
};

const brown = (data: Float32Array): void => {
  let last = 0;
  for (let index = 0; index < data.length; index += 1) {
    // Integrated white noise, kept from drifting.
    last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    data[index] = last * 3.5;
  }
};

const pink = (data: Float32Array): void => {
  // Paul Kellet's economical pink filter.
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  for (let index = 0; index < data.length; index += 1) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    data[index] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
};

/** Sparse, quickly decaying clicks: raindrops or embers, depending on the filter after. */
function clicks(perSecond: number, decaySeconds: number, loudness: number) {
  return (data: Float32Array, rate: number): void => {
    data.fill(0);
    const count = Math.floor((data.length / rate) * perSecond);
    const decay = Math.max(1, Math.floor(rate * decaySeconds));
    for (let click = 0; click < count; click += 1) {
      const at = Math.floor(Math.random() * data.length);
      const amplitude = loudness * (0.3 + Math.random() * 0.7);
      for (let offset = 0; offset < decay && at + offset < data.length; offset += 1) {
        const index = at + offset;
        data[index] =
          (data[index] ?? 0) +
          amplitude * (Math.random() * 2 - 1) * Math.exp((-5 * offset) / decay);
      }
    }
  };
}

function filter(ctx: AudioContext, type: BiquadFilterType, frequency: number): BiquadFilterNode {
  const node = ctx.createBiquadFilter();
  node.type = type;
  node.frequency.value = frequency;
  return node;
}

/** Builds one sound into `out`; returns its sources so it can be stopped. */
function build(id: FocusSoundId, ctx: AudioContext, out: GainNode): AudioScheduledSourceNode[] {
  switch (id) {
    case 'brown': {
      const source = loop(ctx, 4, brown);
      const level = ctx.createGain();
      level.gain.value = 0.55;
      source.connect(level).connect(out);
      return [source];
    }
    case 'pink': {
      const source = loop(ctx, 4, pink);
      const level = ctx.createGain();
      level.gain.value = 0.4;
      source.connect(level).connect(out);
      return [source];
    }
    case 'white': {
      const source = loop(ctx, 3, white);
      const level = ctx.createGain();
      level.gain.value = 0.08;
      source
        .connect(filter(ctx, 'lowpass', 9_000))
        .connect(level)
        .connect(out);
      return [source];
    }
    case 'rain': {
      const bed = loop(ctx, 5, pink);
      const bedLevel = ctx.createGain();
      bedLevel.gain.value = 0.35;
      bed
        .connect(filter(ctx, 'highpass', 500))
        .connect(bedLevel)
        .connect(out);
      const drops = loop(ctx, 7, clicks(60, 0.012, 0.5));
      const dropLevel = ctx.createGain();
      dropLevel.gain.value = 0.25;
      drops
        .connect(filter(ctx, 'bandpass', 3_000))
        .connect(dropLevel)
        .connect(out);
      return [bed, drops];
    }
    case 'waves': {
      const source = loop(ctx, 6, brown);
      const swell = ctx.createGain();
      swell.gain.value = 0.35;
      // A slow swell: a 0.09 Hz oscillator moves the level between about 0.05 and 0.65.
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.09;
      const depth = ctx.createGain();
      depth.gain.value = 0.3;
      lfo.connect(depth).connect(swell.gain);
      source
        .connect(filter(ctx, 'lowpass', 1_000))
        .connect(swell)
        .connect(out);
      return [source, lfo];
    }
    case 'fire': {
      const rumble = loop(ctx, 5, brown);
      const rumbleLevel = ctx.createGain();
      rumbleLevel.gain.value = 0.25;
      rumble
        .connect(filter(ctx, 'lowpass', 400))
        .connect(rumbleLevel)
        .connect(out);
      const crackle = loop(ctx, 9, clicks(7, 0.006, 0.9));
      const crackleLevel = ctx.createGain();
      crackleLevel.gain.value = 0.35;
      crackle
        .connect(filter(ctx, 'highpass', 1_500))
        .connect(crackleLevel)
        .connect(out);
      return [rumble, crackle];
    }
  }
}

function startVoice(id: FocusSoundId): void {
  const ready = context();
  if (ready === null || voices.has(id)) {
    return;
  }
  const { ctx, master } = ready;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(1, ctx.currentTime + 1.5);
  gain.connect(master);
  const sources = build(id, ctx, gain);
  for (const source of sources) {
    source.start();
  }
  voices.set(id, { gain, sources });
}

function stopVoice(id: FocusSoundId): void {
  const voice = voices.get(id);
  if (voice === undefined || audio === null) {
    return;
  }
  voices.delete(id);
  voice.gain.gain.setTargetAtTime(0.0001, audio.ctx.currentTime, 0.3);
  setTimeout(() => {
    for (const source of voice.sources) {
      source.stop();
    }
    voice.gain.disconnect();
  }, 1_200);
}
