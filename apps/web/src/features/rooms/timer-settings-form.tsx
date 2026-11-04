import {
  type RoomId,
  type RoomTimerSettings,
  updateRoomTimerSettingsRequestSchema,
} from '@focus-flow/contracts';
import { useState } from 'react';

import { useRealtimeStatus } from '../realtime/realtime-provider';
import { useRoomLive } from './room-live-store';
import { roomErrorMessage } from './room-messages';
import { useUpdateRoomTimerSettings } from './room-queries';
import { parseMinutes, secondsToMinutesText, TIMER_FIELDS } from './room-time';
import { ConfirmGroup, discardsProgress } from './timer-panel';
import type { TimerCommandsApi } from './use-timer-commands';

type Texts = Record<(typeof TIMER_FIELDS)[number]['key'], string>;

const textsFrom = (settings: RoomTimerSettings): Texts => ({
  focusSeconds: secondsToMinutesText(settings.focusSeconds),
  shortBreakSeconds: secondsToMinutesText(settings.shortBreakSeconds),
  longBreakSeconds: secondsToMinutesText(settings.longBreakSeconds),
});

/**
 * Host only. A change is saved to the server and takes effect from the next phase, never
 * for the one running (D16). Only the lengths the host actually changed are sent.
 */
export function TimerSettingsForm({
  roomId,
  settings,
  commands,
}: {
  roomId: RoomId;
  settings: RoomTimerSettings;
  commands: TimerCommandsApi;
}) {
  const timer = useRoomLive(roomId, (state) => state.timer);
  const joined = useRoomLive(roomId, (state) => state.joinStatus === 'joined');
  const realtime = useRealtimeStatus();
  const [confirmingApply, setConfirmingApply] = useState(false);
  const initial = textsFrom(settings);
  // What the host typed; a field never touched follows the server's value, so a change made
  // elsewhere (room:settings:updated) shows up without discarding anything typed.
  const [edits, setEdits] = useState<Partial<Texts>>({});
  const texts: Texts = { ...initial, ...edits };
  const [invalid, setInvalid] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const update = useUpdateRoomTimerSettings(roomId);

  const changed = TIMER_FIELDS.filter((field) => texts[field.key] !== initial[field.key]);

  function submit(): void {
    const seconds: Record<string, number> = {};
    for (const field of changed) {
      const parsed = parseMinutes(texts[field.key], field.bounds);
      if (!parsed.ok) {
        setInvalid(`${field.label}: ${parsed.error}`);
        return;
      }
      seconds[field.key] = parsed.seconds;
    }
    const request = updateRoomTimerSettingsRequestSchema.safeParse(seconds);
    if (!request.success) {
      setInvalid('Change at least one length.');
      return;
    }
    setInvalid(null);
    setSaved(false);
    update.reset();
    update.mutate(request.data, {
      onSuccess: () => {
        setEdits({});
        setSaved(true);
      },
    });
  }

  const error = invalid ?? (update.error === null ? null : roomErrorMessage(update.error));

  const canApply = timer !== null && realtime === 'connected' && joined && !commands.pending;

  function applyNow(): void {
    if (timer === null) {
      return;
    }
    setConfirmingApply(false);
    void commands.send({ type: 'reset', expectedVersion: timer.version });
  }

  return (
    <div className="space-y-3">
      <form
        noValidate
        aria-label="Timer lengths"
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <h3 className="text-base font-semibold">Timer lengths</h3>
        <div className="flex flex-wrap gap-3">
          {TIMER_FIELDS.map((field) => (
            <div key={field.key} className="space-y-1">
              <label htmlFor={`settings-${field.key}`} className="block text-sm">
                {field.label}
              </label>
              <input
                id={`settings-${field.key}`}
                name={field.key}
                type="number"
                inputMode="numeric"
                value={texts[field.key]}
                onChange={(event) => {
                  setSaved(false);
                  setEdits({ ...edits, [field.key]: event.target.value });
                }}
                className="w-24 rounded border border-slate-300 px-2 py-1"
              />
            </div>
          ))}
        </div>
        <p className="text-xs text-slate-600">Applies from the next phase.</p>
        <p className="text-xs text-slate-600">The phase already on the clock keeps its length.</p>
        <button
          type="submit"
          disabled={update.isPending || changed.length === 0}
          className="rounded bg-slate-900 px-3 py-1 text-white disabled:opacity-50"
        >
          {update.isPending ? 'Saving…' : 'Save lengths'}
        </button>
        <p role="status" aria-live="polite" className="text-sm text-slate-700">
          {saved ? 'Saved. The new lengths apply from the next phase.' : ''}
        </p>
        {error !== null && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
      </form>
      <div className="space-y-2">
        <p className="text-xs text-slate-600">
          Save the new lengths first, then apply them now to restart the current phase with its new
          length.
        </p>
        {confirmingApply && timer !== null ? (
          <ConfirmGroup
            label="Confirm apply now"
            message="Apply now restarts the timer: the time already elapsed in this phase is discarded for everyone in the room."
            confirmLabel="Yes, apply now"
            disabled={!canApply}
            onConfirm={applyNow}
            onCancel={() => {
              setConfirmingApply(false);
            }}
          />
        ) : (
          <button
            type="button"
            disabled={!canApply}
            onClick={() => {
              if (timer !== null && discardsProgress(timer)) {
                setConfirmingApply(true);
              } else {
                applyNow();
              }
            }}
            className="rounded border border-slate-300 px-3 py-1 text-sm disabled:opacity-50"
          >
            Apply now (reset the timer)
          </button>
        )}
      </div>
    </div>
  );
}
