import { useSyncExternalStore } from 'react';

import {
  FOCUS_SOUNDS,
  type FocusSoundId,
  playingSounds,
  playSounds,
  savedSoundChoice,
  setSoundVolume,
  soundVolume,
  stopAllSounds,
  subscribeSounds,
  toggleSound,
} from './sounds';

const NONE: readonly FocusSoundId[] = [];

export function usePlayingSounds(): readonly FocusSoundId[] {
  return useSyncExternalStore(subscribeSounds, playingSounds, () => NONE);
}

const label = (id: FocusSoundId): string =>
  FOCUS_SOUNDS.find((sound) => sound.id === id)?.label ?? id;

/**
 * Pick any number of focus sounds to play together (DF5). Each choice plays at once, so the
 * mix can be heard before the session starts; the same sounds go on into Deep Focus.
 */
export function SoundPicker({ tone }: { readonly tone: 'light' | 'dark' }) {
  const playing = usePlayingSounds();
  const volume = useSyncExternalStore(subscribeSounds, soundVolume, () => 0.6);
  const saved = playing.length === 0 ? savedSoundChoice() : [];
  const dark = tone === 'dark';

  const chip = (on: boolean): string =>
    dark
      ? `rounded-2xl border px-3 py-2 text-left text-sm transition ${
          on
            ? 'border-white/60 bg-white/15 text-white'
            : 'border-white/15 bg-white/5 text-white/70 hover:bg-white/10'
        }`
      : `rounded-2xl border px-3 py-2 text-left text-sm transition ${
          on
            ? 'border-focus bg-focus/15 shadow-glow'
            : 'border-line bg-surface hover:bg-surface-strong'
        }`;
  const muted = dark ? 'text-white/50' : 'text-muted';

  return (
    <div role="group" aria-label="Focus sounds" className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {FOCUS_SOUNDS.map((sound) => {
          const on = playing.includes(sound.id);
          return (
            <button
              key={sound.id}
              type="button"
              aria-pressed={on}
              className={chip(on)}
              onClick={() => {
                toggleSound(sound.id);
              }}
            >
              <span className="block font-medium">{sound.label}</span>
              <span className={`block text-xs ${muted}`}>{sound.hint}</span>
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className={`flex items-center gap-2 ${muted}`}>
          Volume
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(volume * 100)}
            onChange={(event) => {
              setSoundVolume(Number(event.target.value) / 100);
            }}
            className={dark ? 'accent-white' : 'accent-focus'}
          />
        </label>
        {playing.length > 0 ? (
          <button
            type="button"
            className={`underline underline-offset-4 ${muted}`}
            onClick={stopAllSounds}
          >
            Silence
          </button>
        ) : (
          saved.length > 0 && (
            <button
              type="button"
              className={`underline underline-offset-4 ${muted}`}
              onClick={() => {
                playSounds(saved);
              }}
            >
              {`Use your last mix (${saved.map(label).join(', ')})`}
            </button>
          )
        )}
      </div>
    </div>
  );
}
