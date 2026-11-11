import type { FocusSessionView, RoomId, TaskId, TaskView, UserId } from '@focus-flow/contracts';
import { useEffect, useRef, useState } from 'react';

import { useAuth } from '../auth/auth-context';
import { focusOutcomeMessage } from '../focus/focus-outcome';
import {
  useCurrentFocusSession,
  useDismissLastEnded,
  useLastEndedFocusSession,
} from '../focus/focus-queries';
import { formatClock, wholeMinutes } from '../focus/focus-time';
import { useRealtimeStatus } from '../realtime/realtime-provider';
import { useTask, useTaskList } from '../tasks/task-queries';
import { roomFocusErrorMessage } from './room-focus-messages';
import { RoomFocusParticipants } from './room-focus-participants';
import { useRoomFocusActions, useRoomFocusState } from './room-focus-queries';
import { useRoomLive } from './room-live-store';
import { PHASE_LABEL, remainingSecondsAt, STATUS_LABEL } from './timer-display';
import { ConfirmGroup } from './timer-panel';
import { useTimerClock } from './use-timer-clock';

const PRIMARY = 'rounded bg-slate-900 px-3 py-1 text-sm text-white disabled:opacity-50';
const SECONDARY = 'rounded border border-slate-300 px-3 py-1 text-sm disabled:opacity-50';
const FOCUS_RING = 'focus-visible:outline-2 focus-visible:outline-offset-2';

type InProgress = Extract<FocusSessionView, { status: 'in_progress' }>;

/** The optional task of the person's own session, chosen from their open tasks. */
function TaskPicker({
  value,
  onChange,
  disabled,
}: {
  value: string | null;
  onChange: (taskId: string) => void;
  disabled: boolean;
}) {
  const { user } = useAuth();
  const currentTaskId = user?.currentTaskId ?? null;
  const openTasks = useTaskList('open');
  const currentTask = useTask(currentTaskId);

  // The first page of open tasks, plus the current task when it is open but on a later page.
  const options: TaskView[] = openTasks.data?.pages.flatMap((page) => page.tasks) ?? [];
  const current = currentTask.data;
  if (
    current !== undefined &&
    current.status === 'open' &&
    !options.some((task) => task.id === current.id)
  ) {
    options.unshift(current);
  }
  // Preselecting the current task is a visible convenience; the server never infers it (E3).
  const wanted = value ?? currentTaskId ?? '';
  const selected = options.some((task) => task.id === wanted) ? wanted : '';

  return (
    <div className="space-y-1">
      <label htmlFor="room-focus-task" className="block text-sm font-medium">
        Your task for this run (optional)
      </label>
      <select
        id="room-focus-task"
        name="taskId"
        value={selected}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className="w-full rounded border border-slate-300 px-2 py-1 disabled:opacity-50"
      >
        <option value="">No task</option>
        {options.map((task) => (
          <option key={task.id} value={task.id}>
            {task.title}
          </option>
        ))}
      </select>
      <p className="text-xs text-slate-600">
        Only you see your task. The others see that you are focusing, not what on.
      </p>
    </div>
  );
}

/**
 * The room's "Focus together" panel (Phase 8, RF13). Being in the room never starts a
 * session: the person opts in here, explicitly (D11), and the server decides everything: the
 * plan length, whether the run is still joinable, how the session ends. The browser shows the
 * server's picture (join snapshot and `room:focus:participants` events through the live
 * store, plus `GET …/focus-participation` for the person's own session) and its countdowns
 * are display only. Every end is explained in words from the session record the server wrote.
 */
export function RoomFocusPanel({
  roomId,
  currentUserId,
  refresh,
}: {
  roomId: RoomId;
  currentUserId: UserId;
  /** A safe re-read: `room:join` is idempotent and answers the authoritative snapshot. */
  refresh: () => void;
}) {
  const realtime = useRealtimeStatus();
  const joined = useRoomLive(roomId, (state) => state.joinStatus === 'joined');
  const timer = useRoomLive(roomId, (state) => state.timer);
  const live = useRoomLive(roomId, (state) => state.focus);
  const restState = useRoomFocusState(roomId);
  const current = useCurrentFocusSession();
  const actions = useRoomFocusActions(roomId, refresh);
  const lastEnded = useLastEndedFocusSession();
  const dismissEnded = useDismissLastEnded();
  const { nowMs } = useTimerClock();
  const [taskChoice, setTaskChoice] = useState<string | null>(null);
  const [confirmingLeave, setConfirmingLeave] = useState(false);

  // The person's own in-progress session of this room: what `current` says once it has been
  // read, otherwise what the room's own read says (restores a reloaded page).
  const inThisRoom = (session: FocusSessionView | null | undefined): InProgress | null =>
    session?.status === 'in_progress' &&
    session.context.kind === 'room' &&
    session.context.roomId === roomId
      ? session
      : null;
  const mySession =
    current.data !== undefined ? inThisRoom(current.data) : inThisRoom(restState.data?.session);
  const otherSession =
    current.data?.status === 'in_progress' && inThisRoom(current.data) === null
      ? current.data
      : null;

  const liveList = joined && live !== null;
  const participants = liveList
    ? live.participants
    : (restState.data?.participants ?? live?.participants ?? []);
  const participating =
    mySession !== null || participants.some((entry) => entry.userId === currentUserId);

  const canAct = realtime === 'connected' && joined;
  const busy = actions.pending;
  const inFocusPhase = timer !== null && timer.phase === 'focus' && timer.focusRunId !== null;

  // Replacing "Join" with "Leave" (and back) unmounts the focused button; hand focus to its
  // successor, but only if it was lost or is already inside the panel.
  const rootRef = useRef<HTMLDivElement>(null);
  const joinRef = useRef<HTMLButtonElement>(null);
  const leaveRef = useRef<HTMLButtonElement>(null);
  const wasParticipating = useRef(participating);
  useEffect(() => {
    if (wasParticipating.current === participating) {
      return;
    }
    wasParticipating.current = participating;
    setConfirmingLeave(false);
    const active = document.activeElement;
    if (active === null || active === document.body || rootRef.current?.contains(active) === true) {
      (participating ? leaveRef : joinRef).current?.focus();
    }
  }, [participating]);

  const outcome =
    !participating &&
    lastEnded !== null &&
    lastEnded.status !== 'in_progress' &&
    lastEnded.context.kind === 'room' &&
    lastEnded.context.roomId === roomId
      ? lastEnded
      : null;

  function submitJoin(): void {
    actions.clearError();
    void actions.join(taskChoice === null ? null : (taskChoice as TaskId));
  }

  const phaseLine =
    timer === null
      ? 'The timer has not loaded yet.'
      : `${PHASE_LABEL[timer.phase]} · ${STATUS_LABEL[timer.status].toLowerCase()} · ${formatClock(remainingSecondsAt(timer, nowMs))} left`;

  let action;
  if (participating) {
    action = confirmingLeave ? (
      <ConfirmGroup
        label="Confirm leaving the focus run"
        message="Leave this focus run? The time you focused so far is recorded, but the session will not count as completed."
        confirmLabel={busy ? 'Leaving…' : 'Yes, leave the focus run'}
        disabled={busy}
        onConfirm={() => {
          actions.clearError();
          void actions.leave().then((ok) => {
            if (ok) {
              setConfirmingLeave(false);
            }
          });
        }}
        onCancel={() => {
          setConfirmingLeave(false);
        }}
      />
    ) : (
      <div className="space-y-2">
        <p className="text-sm font-medium">
          {mySession === null
            ? 'You are focusing with the room.'
            : `You are focusing with the room${mySession.task === null ? '' : ` on “${mySession.task.title}”`}, ${String(wholeMinutes(mySession.plannedSeconds))} min planned.`}
        </p>
        <button
          ref={leaveRef}
          type="button"
          disabled={busy}
          onClick={() => {
            actions.clearError();
            setConfirmingLeave(true);
          }}
          className={`${SECONDARY} ${FOCUS_RING}`}
        >
          {busy ? 'Leaving…' : 'Leave focus'}
        </button>
        {realtime !== 'connected' && (
          <p role="status" className="text-sm text-amber-800">
            You are disconnected. Your focus continues while Focus Flow reconnects you, but your
            session ends if you stay away for about a minute.
          </p>
        )}
      </div>
    );
  } else if (timer !== null && !inFocusPhase) {
    action = (
      <p className="text-sm text-slate-700">
        {`The room is in a ${PHASE_LABEL[timer.phase].toLowerCase()}. You can join the next focus phase when it begins.`}
      </p>
    );
  } else if (otherSession !== null) {
    action = (
      <p className="text-sm text-slate-700">
        {`You already have a focus session in progress${otherSession.context.kind === 'room' ? ' in another room' : ' on your own'}. Finish or end it before joining this one.`}
      </p>
    );
  } else {
    action = (
      <form
        noValidate
        aria-label="Join the focus run"
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (canAct && inFocusPhase && !busy) {
            submitJoin();
          }
        }}
      >
        <TaskPicker value={taskChoice} onChange={setTaskChoice} disabled={busy} />
        <button
          ref={joinRef}
          type="submit"
          disabled={busy || !canAct || !inFocusPhase}
          className={`${PRIMARY} ${FOCUS_RING}`}
        >
          {busy ? 'Joining…' : 'Join focus'}
        </button>
        {!canAct && (
          <p role="status" className="text-sm text-amber-800">
            {realtime === 'idle'
              ? 'Joining needs a live connection. Reconnect to join the focus run.'
              : 'Joining is paused while the room connects.'}
          </p>
        )}
        <p className="text-xs text-slate-600">
          Joining counts from now until the end of this focus phase. Nothing is recorded unless you
          join.
        </p>
      </form>
    );
  }

  return (
    <section aria-labelledby="room-focus-heading" className="space-y-3">
      <h3 id="room-focus-heading" className="text-base font-semibold">
        Focus together
      </h3>
      <p className="text-sm text-slate-700">
        Being in the room does not start a focus session. You join the focus run yourself.
      </p>
      <p className="text-sm">
        <span className="font-medium">Room timer: </span>
        {phaseLine}{' '}
        <a href="#timer-heading" className="underline">
          Go to the timer
        </a>
      </p>

      <div ref={rootRef} aria-busy={busy} className="space-y-3">
        {action}
        {busy && (
          <p role="status" className="text-sm text-slate-600">
            Sending to the server…
          </p>
        )}
        {actions.error !== null && (
          <p role="alert" className="text-sm text-red-700">
            {roomFocusErrorMessage(actions.error)}
          </p>
        )}
      </div>

      {outcome !== null && (
        <div role="status" className="space-y-2 rounded border border-slate-300 bg-slate-50 p-3">
          <p className="text-sm">{focusOutcomeMessage(outcome)}</p>
          <button
            type="button"
            onClick={() => {
              dismissEnded();
            }}
            className={`${SECONDARY} ${FOCUS_RING}`}
          >
            Dismiss
          </button>
        </div>
      )}

      {restState.isError && restState.data === undefined && live === null && (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-red-700">
            {roomFocusErrorMessage(restState.error)}
          </p>
          <button
            type="button"
            onClick={() => {
              void restState.refetch();
            }}
            className={SECONDARY}
          >
            Retry
          </button>
        </div>
      )}

      <RoomFocusParticipants
        participants={participants}
        selfId={currentUserId}
        nowMs={nowMs}
        stale={!liveList}
      />
    </section>
  );
}
