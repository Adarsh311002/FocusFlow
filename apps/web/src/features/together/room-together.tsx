import { ROOM_SCHEDULE_TITLE_MAX_LENGTH } from '@focus-flow/contracts';
import { useId, useState } from 'react';

import { buttonClass, INPUT_CLASS } from '../../ui/primitives';
import { formatDuration } from '../review/review-format';
import { avatarGlyph } from '../settings/settings-page';
import {
  useCreateSchedule,
  useDeleteSchedule,
  useRoomRecap,
  useRoomSchedules,
} from './together-data';

// A room's plans and its week (SC4, RR3): scheduled sessions everyone can see (the host
// adds and removes them), and what the room did together over the last 7 days.

const WEEKDAY_TIME = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export function RoomSchedule({ roomId, isHost }: { roomId: string; isHost: boolean }) {
  const schedules = useRoomSchedules(roomId);
  const create = useCreateSchedule(roomId);
  const remove = useDeleteSchedule(roomId);
  const [title, setTitle] = useState('');
  const [when, setWhen] = useState('');
  const [minutes, setMinutes] = useState('50');
  const [weekly, setWeekly] = useState(true);
  const titleId = useId();
  const whenId = useId();
  const minutesId = useId();
  const list = (schedules.data ?? []).filter((schedule) => schedule.nextStartsAt !== null);

  return (
    <section aria-labelledby="room-schedule" className="space-y-4">
      <h3 id="room-schedule" className="font-display text-3xl">
        Planned together
      </h3>
      {list.length === 0 ? (
        <p className="text-sm text-muted">
          {isHost
            ? 'Nothing planned yet. Set a regular time and everyone gets a reminder.'
            : 'Nothing planned yet.'}
        </p>
      ) : (
        <ul aria-label="Planned sessions" className="space-y-2">
          {list.map((schedule) => (
            <li key={schedule.id} className="flex flex-wrap items-baseline gap-x-3 text-sm">
              <span className="font-medium">{schedule.title}</span>
              <span className="text-muted">
                {`${WEEKDAY_TIME.format(new Date(schedule.nextStartsAt ?? schedule.startsAt))} · ${String(schedule.durationMinutes)} min${schedule.repeatsWeekly ? ' · every week' : ''}`}
              </span>
              {isHost && (
                <button
                  type="button"
                  disabled={remove.isPending}
                  aria-label={`Remove “${schedule.title}”`}
                  onClick={() => {
                    remove.mutate(schedule.id);
                  }}
                  className="text-xs text-muted hover:text-ink"
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {isHost && (
        <form
          aria-label="Plan a session"
          className="space-y-3 border-t border-line pt-4"
          onSubmit={(event) => {
            event.preventDefault();
            const startsMs = Date.parse(when);
            if (title.trim() === '' || Number.isNaN(startsMs)) {
              return;
            }
            create.mutate(
              {
                title,
                startsAt: new Date(startsMs).toISOString(),
                durationMinutes: Number(minutes),
                repeatsWeekly: weekly,
              },
              {
                onSuccess: () => {
                  setTitle('');
                  setWhen('');
                },
              },
            );
          }}
        >
          <div>
            <label htmlFor={titleId} className="mb-1 block text-xs text-muted">
              What
            </label>
            <input
              id={titleId}
              type="text"
              value={title}
              maxLength={ROOM_SCHEDULE_TITLE_MAX_LENGTH}
              placeholder="e.g. Morning deep work"
              onChange={(event) => {
                setTitle(event.target.value);
              }}
              className={INPUT_CLASS}
            />
          </div>
          <div className="flex flex-wrap gap-3">
            <div>
              <label htmlFor={whenId} className="mb-1 block text-xs text-muted">
                When
              </label>
              <input
                id={whenId}
                type="datetime-local"
                value={when}
                onChange={(event) => {
                  setWhen(event.target.value);
                }}
                className={INPUT_CLASS}
              />
            </div>
            <div>
              <label htmlFor={minutesId} className="mb-1 block text-xs text-muted">
                For
              </label>
              <select
                id={minutesId}
                value={minutes}
                onChange={(event) => {
                  setMinutes(event.target.value);
                }}
                className={INPUT_CLASS}
              >
                {[25, 50, 90, 120].map((option) => (
                  <option key={option} value={String(option)}>
                    {`${String(option)} min`}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={weekly}
              onChange={(event) => {
                setWeekly(event.target.checked);
              }}
            />
            Every week at this time
          </label>
          <button
            type="submit"
            disabled={create.isPending || title.trim() === '' || when === ''}
            className={buttonClass('ghost', 'px-5 py-2 text-xs')}
          >
            Plan it
          </button>
          {create.isError && (
            <p role="alert" className="text-sm text-danger">
              That did not save. Pick a time in the future and try again.
            </p>
          )}
        </form>
      )}
    </section>
  );
}

export function RoomRecap({ roomId }: { roomId: string }) {
  const recap = useRoomRecap(roomId);
  if (!recap.isSuccess) {
    return null;
  }
  const { totals, people, roomStreak } = recap.data;
  return (
    <section aria-labelledby="room-recap" className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="room-recap" className="font-display text-3xl">
          This week here
        </h3>
        <span className="text-sm text-muted">
          {roomStreak > 0 ? `🔥 ${String(roomStreak)}-day room streak` : 'No streak yet'}
        </span>
      </div>
      <dl className="grid grid-cols-3 gap-3 text-center">
        {[
          ['Together', formatDuration(totals.focusedSeconds)],
          ['Sessions', String(totals.completedSessions)],
          ['Finished', String(totals.intentionsDone)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-2xl border border-line p-3">
            <dt className="text-[10px] tracking-[0.3em] text-muted uppercase">{label}</dt>
            <dd className="font-display mt-1 text-2xl">{value}</dd>
          </div>
        ))}
      </dl>
      {people.length === 0 ? (
        <p className="text-sm text-muted">No one has focused here this week yet.</p>
      ) : (
        <ul aria-label="Who showed up" className="space-y-1.5 text-sm">
          {people.map((person) => (
            <li key={person.userId} className="flex items-center gap-3">
              <span aria-hidden="true" className="w-6 text-center">
                {avatarGlyph(person)}
              </span>
              <span className="flex-1">{person.displayName}</span>
              <span className="text-muted">{formatDuration(person.focusedSeconds)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
