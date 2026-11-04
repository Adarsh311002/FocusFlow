import {
  DEFAULT_ROOM_TIMER_SETTINGS,
  ROOM_NAME_MAX_LENGTH,
  roomNameSchema,
  roomTimerSettingsSchema,
} from '@focus-flow/contracts';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';

import { INVALID_ROOM_NAME, roomErrorMessage } from './room-messages';
import { useCreateRoom } from './room-queries';
import { parseMinutes, secondsToMinutesText, TIMER_FIELDS } from './room-time';

type Texts = Record<(typeof TIMER_FIELDS)[number]['key'], string>;

const DEFAULT_TEXTS: Texts = {
  focusSeconds: secondsToMinutesText(DEFAULT_ROOM_TIMER_SETTINGS.focusSeconds),
  shortBreakSeconds: secondsToMinutesText(DEFAULT_ROOM_TIMER_SETTINGS.shortBreakSeconds),
  longBreakSeconds: secondsToMinutesText(DEFAULT_ROOM_TIMER_SETTINGS.longBreakSeconds),
};

/** Creates a room (the creator becomes host and first member) and opens it. */
export function CreateRoomForm() {
  const navigate = useNavigate();
  const create = useCreateRoom();
  const [name, setName] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [texts, setTexts] = useState<Texts>(DEFAULT_TEXTS);
  const [invalid, setInvalid] = useState<string | null>(null);

  function submit(): void {
    const parsedName = roomNameSchema.safeParse(name);
    if (!parsedName.success) {
      setInvalid(INVALID_ROOM_NAME);
      return;
    }
    const seconds: Record<string, number> = {};
    for (const field of TIMER_FIELDS) {
      const parsed = parseMinutes(texts[field.key], field.bounds);
      if (!parsed.ok) {
        setInvalid(`${field.label}: ${parsed.error}`);
        return;
      }
      seconds[field.key] = parsed.seconds;
    }
    const timerSettings = roomTimerSettingsSchema.safeParse(seconds);
    if (!timerSettings.success) {
      setInvalid('Check the timer lengths and try again.');
      return;
    }
    setInvalid(null);
    create.reset();
    create.mutate(
      {
        name: parsedName.data,
        isPrivate,
        timerSettings: timerSettings.data,
      },
      {
        onSuccess: (room) => {
          setName('');
          void navigate({ to: '/rooms/$roomId', params: { roomId: room.id } });
        },
      },
    );
  }

  const error = invalid ?? (create.error === null ? null : roomErrorMessage(create.error));

  return (
    <form
      noValidate
      aria-label="Create a room"
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <h3 className="text-base font-semibold">Create a room</h3>
      <div className="space-y-1">
        <label htmlFor="room-name" className="block text-sm font-medium">
          Room name
        </label>
        <input
          id="room-name"
          name="name"
          type="text"
          autoComplete="off"
          maxLength={ROOM_NAME_MAX_LENGTH}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          className="w-full rounded border border-slate-300 px-2 py-1"
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={isPrivate}
          onChange={(event) => {
            setIsPrivate(event.target.checked);
          }}
        />
        Private (people must ask the host to join)
      </label>
      <details className="space-y-2">
        <summary className="cursor-pointer text-sm font-medium">Timer lengths</summary>
        <div className="mt-2 flex flex-wrap gap-3">
          {TIMER_FIELDS.map((field) => (
            <div key={field.key} className="space-y-1">
              <label htmlFor={`create-${field.key}`} className="block text-sm">
                {field.label}
              </label>
              <input
                id={`create-${field.key}`}
                name={field.key}
                type="number"
                inputMode="numeric"
                value={texts[field.key]}
                onChange={(event) => {
                  setTexts({ ...texts, [field.key]: event.target.value });
                }}
                className="w-24 rounded border border-slate-300 px-2 py-1"
              />
            </div>
          ))}
        </div>
      </details>
      <button
        type="submit"
        disabled={create.isPending}
        className="rounded bg-slate-900 px-3 py-1 text-white disabled:opacity-50"
      >
        {create.isPending ? 'Creating…' : 'Create room'}
      </button>
      {error !== null && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </form>
  );
}
