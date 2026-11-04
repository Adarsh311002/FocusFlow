import {
  ROOM_FOCUS_SECONDS,
  ROOM_LONG_BREAK_SECONDS,
  ROOM_SHORT_BREAK_SECONDS,
  type RoomTimerSettings,
} from '@focus-flow/contracts';

type Bounds = { readonly min: number; readonly max: number };

/** The three phase lengths in the order the forms show them; bounds come from the contract. */
export const TIMER_FIELDS: ReadonlyArray<{
  readonly key: keyof RoomTimerSettings;
  readonly label: string;
  readonly bounds: Bounds;
}> = [
  { key: 'focusSeconds', label: 'Focus (minutes)', bounds: ROOM_FOCUS_SECONDS },
  { key: 'shortBreakSeconds', label: 'Short break (minutes)', bounds: ROOM_SHORT_BREAK_SECONDS },
  { key: 'longBreakSeconds', label: 'Long break (minutes)', bounds: ROOM_LONG_BREAK_SECONDS },
];

export const secondsToMinutesText = (seconds: number): string => String(Math.round(seconds / 60));

export type ParsedMinutes =
  { readonly ok: true; readonly seconds: number } | { readonly ok: false; readonly error: string };

/** Whole minutes only, converted to the whole seconds the API takes. */
export function parseMinutes(text: string, bounds: Bounds): ParsedMinutes {
  const min = Math.ceil(bounds.min / 60);
  const max = Math.floor(bounds.max / 60);
  const trimmed = text.trim();
  if (!/^\d{1,4}$/u.test(trimmed)) {
    return { ok: false, error: `Enter whole minutes from ${String(min)} to ${String(max)}.` };
  }
  const minutes = Number(trimmed);
  if (minutes < min || minutes > max) {
    return { ok: false, error: `Enter whole minutes from ${String(min)} to ${String(max)}.` };
  }
  return { ok: true, seconds: minutes * 60 };
}
