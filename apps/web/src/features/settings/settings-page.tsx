import {
  type AvatarPreset,
  DEFAULT_SESSION_SECONDS,
  mePaths,
  type MeResponse,
  meResponseSchema,
  type UpdateMeRequest,
} from '@focus-flow/contracts';
import { useMutation } from '@tanstack/react-query';
import { type ReactNode, useId, useState } from 'react';

import { disableForest, enableForest, useForestSound } from '../../ui/jungle/soundscape';
import { buttonClass, Eyebrow, INPUT_CLASS } from '../../ui/primitives';
import { useTheme } from '../../ui/theme';
import { authedApiRequest } from '../auth/auth-client';
import { useAuth } from '../auth/auth-context';
import { dailyGoalOf, useSetDailyGoal } from '../intention/intention-queries';

// Settings (ST1–ST5): the person's profile and focus defaults, saved with `PATCH /me`, and
// this device's look and sound. One section per concern; every save answers with the user.

export const AVATARS: readonly { preset: AvatarPreset; emoji: string; name: string }[] = [
  { preset: 'monkey', emoji: '🐒', name: 'Monkey' },
  { preset: 'sloth', emoji: '🦥', name: 'Sloth' },
  { preset: 'toucan', emoji: '🦜', name: 'Toucan' },
  { preset: 'frog', emoji: '🐸', name: 'Frog' },
  { preset: 'owl', emoji: '🦉', name: 'Owl' },
  { preset: 'butterfly', emoji: '🦋', name: 'Butterfly' },
  { preset: 'jaguar', emoji: '🐆', name: 'Jaguar' },
];

/** The avatar to show for a user: their animal, or the initial of their name. */
export function avatarGlyph(user: {
  readonly displayName: string;
  readonly avatarPreset?: AvatarPreset | null | undefined;
}): string {
  const chosen = AVATARS.find((avatar) => avatar.preset === user.avatarPreset);
  return chosen?.emoji ?? user.displayName.charAt(0).toUpperCase();
}

function useUpdateMe() {
  const { updateUser } = useAuth();
  return useMutation({
    mutationFn: (request: UpdateMeRequest) =>
      authedApiRequest<MeResponse>(mePaths.self, meResponseSchema, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      }),
    onSuccess: (answer) => {
      updateUser(answer.user);
    },
  });
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="space-y-5 rounded-[2rem] border border-line bg-surface p-6 shadow-card backdrop-blur-xl md:p-8"
    >
      <h3 id={id} className="font-display text-3xl">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Saved({ state }: { readonly state: { isSuccess: boolean; isError: boolean } }) {
  if (state.isError) {
    return (
      <p role="alert" className="text-sm text-danger">
        That did not save. Try again.
      </p>
    );
  }
  return state.isSuccess ? (
    <p role="status" className="text-sm text-focus">
      Saved.
    </p>
  ) : null;
}

function Profile() {
  const { user } = useAuth();
  const update = useUpdateMe();
  const [name, setName] = useState(user?.displayName ?? '');
  const nameId = useId();
  if (user === null) {
    return null;
  }
  return (
    <Section title="You">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() !== '' && name.trim() !== user.displayName) {
            update.mutate({ displayName: name });
          }
        }}
      >
        <div className="min-w-0 flex-1">
          <label htmlFor={nameId} className="mb-1 block text-sm text-muted">
            Display name
          </label>
          <input
            id={nameId}
            type="text"
            value={name}
            maxLength={50}
            onChange={(event) => {
              setName(event.target.value);
            }}
            className={INPUT_CLASS}
          />
        </div>
        <button
          type="submit"
          disabled={update.isPending || name.trim() === '' || name.trim() === user.displayName}
          className={buttonClass('primary', 'px-5 py-2.5')}
        >
          {update.isPending ? 'Saving…' : 'Save name'}
        </button>
      </form>
      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm text-muted">Your forest companion</legend>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            aria-pressed={user.avatarPreset === null || user.avatarPreset === undefined}
            onClick={() => {
              update.mutate({ avatarPreset: null });
            }}
            className={`grid h-12 w-12 place-items-center rounded-full border font-display text-xl transition ${
              user.avatarPreset === null || user.avatarPreset === undefined
                ? 'border-focus bg-focus text-focus-ink'
                : 'border-line hover:border-focus/60'
            }`}
          >
            <span aria-hidden="true">{user.displayName.charAt(0).toUpperCase()}</span>
            <span className="sr-only">Just my initial</span>
          </button>
          {AVATARS.map((avatar) => (
            <button
              key={avatar.preset}
              type="button"
              aria-pressed={user.avatarPreset === avatar.preset}
              onClick={() => {
                update.mutate({ avatarPreset: avatar.preset });
              }}
              className={`grid h-12 w-12 place-items-center rounded-full border text-2xl transition ${
                user.avatarPreset === avatar.preset
                  ? 'border-focus bg-focus/20 shadow-glow'
                  : 'border-line hover:border-focus/60'
              }`}
            >
              <span aria-hidden="true">{avatar.emoji}</span>
              <span className="sr-only">{avatar.name}</span>
            </button>
          ))}
        </div>
      </fieldset>
      <p className="text-sm text-muted">{user.email}</p>
      <Saved state={update} />
    </Section>
  );
}

const SESSION_MINUTES = [15, 25, 50, 90] as const;
const GOAL_HOURS = [1, 2, 3, 4, 5, 6, 8] as const;

function FocusDefaults() {
  const { user } = useAuth();
  const update = useUpdateMe();
  const setGoal = useSetDailyGoal();
  const minutes = (user?.defaultSessionSeconds ?? DEFAULT_SESSION_SECONDS) / 60;
  const goalHours = dailyGoalOf(user) / 3600;
  const [custom, setCustom] = useState('');
  const customId = useId();
  return (
    <Section title="Focus">
      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm text-muted">A session starts at</legend>
        <div className="flex flex-wrap items-center gap-2">
          {SESSION_MINUTES.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={minutes === option}
              onClick={() => {
                update.mutate({ defaultSessionSeconds: option * 60 });
              }}
              className={`rounded-full border px-4 py-2 text-sm transition ${
                minutes === option
                  ? 'border-focus bg-focus/15'
                  : 'border-line hover:bg-surface-strong'
              }`}
            >
              {`${String(option)} min`}
            </button>
          ))}
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const value = Number(custom);
              if (Number.isInteger(value) && value >= 1 && value <= 240) {
                update.mutate({ defaultSessionSeconds: value * 60 });
                setCustom('');
              }
            }}
          >
            <label htmlFor={customId} className="sr-only">
              Other length in minutes (1–240)
            </label>
            <input
              id={customId}
              type="number"
              min={1}
              max={240}
              inputMode="numeric"
              value={custom}
              placeholder={SESSION_MINUTES.includes(minutes as 15) ? 'Other' : String(minutes)}
              onChange={(event) => {
                setCustom(event.target.value);
              }}
              className={`${INPUT_CLASS} w-24`}
            />
            <button type="submit" className={buttonClass('ghost', 'px-3 py-2 text-xs')}>
              Set
            </button>
          </form>
        </div>
      </fieldset>
      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm text-muted">Daily focus goal</legend>
        <div className="flex flex-wrap gap-2">
          {GOAL_HOURS.map((hours) => (
            <button
              key={hours}
              type="button"
              aria-pressed={goalHours === hours}
              onClick={() => {
                setGoal.mutate(hours * 3600);
              }}
              className={`rounded-full border px-4 py-2 text-sm transition ${
                goalHours === hours
                  ? 'border-focus bg-focus/15'
                  : 'border-line hover:bg-surface-strong'
              }`}
            >
              {hours === 1 ? '1 hour' : `${String(hours)} hours`}
            </button>
          ))}
        </div>
      </fieldset>
      <Saved
        state={{
          isSuccess: update.isSuccess || setGoal.isSuccess,
          isError: update.isError || setGoal.isError,
        }}
      />
    </Section>
  );
}

function ThisDevice() {
  const { theme, toggleTheme } = useTheme();
  const soundOn = useForestSound();
  return (
    <Section title="This device">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p>
          Theme:{' '}
          <strong className="font-medium">
            {theme === 'dark' ? 'Night forest' : 'Day forest'}
          </strong>
        </p>
        <button type="button" onClick={toggleTheme} className={buttonClass('ghost', 'px-4 py-2')}>
          {`Switch to ${theme === 'dark' ? 'day' : 'night'}`}
        </button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p>
          Forest sounds: <strong className="font-medium">{soundOn ? 'Playing' : 'Off'}</strong>
        </p>
        <button
          type="button"
          onClick={soundOn ? disableForest : enableForest}
          className={buttonClass('ghost', 'px-4 py-2')}
        >
          {soundOn ? 'Turn off' : 'Play them'}
        </button>
      </div>
      <p className="text-sm text-muted">
        These are kept in this browser. The 3D forest rests automatically when your system asks for
        reduced motion.
      </p>
    </Section>
  );
}

/** `/settings` (ST4). */
export function SettingsPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <Eyebrow>( Settings )</Eyebrow>
        <h2 className="font-display mt-3 text-6xl">Make it yours</h2>
      </div>
      <Profile />
      <FocusDefaults />
      <ThisDevice />
    </div>
  );
}
