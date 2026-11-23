import { CHAT_BODY_MAX_LENGTH, type RoomId, type UserId } from '@focus-flow/contracts';
import { useEffect, useRef, useState } from 'react';

import { useRealtimeClient } from '../realtime/realtime-provider';
import { type ChatEntry, getRoomLiveStore, useRoomLive } from './room-live-store';
import { INVALID_CHAT_BODY, socketErrorMessage } from './room-messages';

/** How close to the bottom (px) still counts as "reading the latest messages". */
const NEAR_BOTTOM_PX = 48;

const timeOf = (sentAtMs: number): string =>
  new Date(sentAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * Temporary room chat (D7, D24): messages live only in this tab's memory for this visit.
 * Sending needs a joined room; a failed message keeps its `clientMessageId`, so a retry is
 * answered by the server instead of being delivered twice (M8).
 */
export function ChatPanel({
  roomId,
  currentUserId,
  canSend,
}: {
  roomId: RoomId;
  currentUserId: UserId;
  /** The socket is connected and the room is joined. */
  canSend: boolean;
}) {
  const client = useRealtimeClient();
  const messages = useRoomLive(roomId, (state) => state.messages);
  const [draft, setDraft] = useState('');
  const [invalid, setInvalid] = useState(false);
  const logRef = useRef<HTMLOListElement>(null);
  const stickToBottom = useRef(true);

  // Follow new messages only while the reader is at the bottom (or just sent one), so
  // scrolling up to read is never fought.
  const last = messages.at(-1);
  const lastIsMine = last?.sender.userId === currentUserId;
  useEffect(() => {
    const log = logRef.current;
    if (log !== null && (stickToBottom.current || lastIsMine)) {
      log.scrollTop = log.scrollHeight;
    }
  }, [messages.length, last?.status, lastIsMine]);

  async function deliver(entry: ChatEntry): Promise<void> {
    const store = getRoomLiveStore(roomId).getState();
    const ack = await client.sendChat(roomId, entry.clientMessageId, entry.body);
    if (ack.ok) {
      store.chatSent(entry.clientMessageId, { messageId: ack.messageId, sentAtMs: ack.sentAtMs });
    } else {
      store.chatFailed(entry.clientMessageId, socketErrorMessage(ack));
    }
  }

  function send(): void {
    const body = draft.trim();
    if (body.length === 0 || body.length > CHAT_BODY_MAX_LENGTH) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    const entry: ChatEntry = {
      clientMessageId: crypto.randomUUID(),
      messageId: null,
      sender: { userId: currentUserId, displayName: 'You' },
      body,
      sentAtMs: null,
      status: 'pending',
      error: null,
    };
    getRoomLiveStore(roomId).getState().chatPending(entry);
    setDraft('');
    void deliver(entry);
  }

  function retry(entry: ChatEntry): void {
    getRoomLiveStore(roomId).getState().chatRetrying(entry.clientMessageId);
    void deliver({ ...entry, status: 'pending', error: null });
  }

  return (
    <section aria-labelledby="chat-heading" className="space-y-2">
      <h3 id="chat-heading" className="font-display text-3xl">
        Chat
      </h3>
      <p className="text-xs text-muted">Messages are temporary and disappear when you leave.</p>
      <ol
        ref={logRef}
        role="log"
        aria-label="Chat messages"
        aria-live="polite"
        // A scrollable region must be reachable by keyboard to be scrolled without a mouse.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        onScroll={(event) => {
          const log = event.currentTarget;
          stickToBottom.current =
            log.scrollHeight - log.scrollTop - log.clientHeight <= NEAR_BOTTOM_PX;
        }}
        className="max-h-64 space-y-1 overflow-y-auto rounded-2xl border border-line bg-surface p-4"
      >
        {messages.length === 0 && <li className="text-sm text-muted">No messages yet.</li>}
        {messages.map((message) => (
          <li key={message.clientMessageId} className="text-sm">
            <span className="font-medium">
              {message.sender.userId === currentUserId ? 'You' : message.sender.displayName}
            </span>
            {message.sentAtMs !== null && (
              <span className="ml-2 text-xs text-muted">{timeOf(message.sentAtMs)}</span>
            )}
            <span className="block whitespace-pre-wrap break-words">{message.body}</span>
            {message.status === 'pending' && <span className="text-xs text-muted">Sending…</span>}
            {message.status === 'failed' && (
              <span className="flex flex-wrap items-center gap-2 text-xs text-danger">
                <span>{`Not sent. ${message.error ?? ''}`.trim()}</span>
                <button
                  type="button"
                  disabled={!canSend}
                  onClick={() => {
                    retry(message);
                  }}
                  className="rounded-full border border-line bg-surface px-4 py-1.5 transition hover:bg-surface-strong text-ink disabled:opacity-50"
                >
                  Retry
                </button>
              </span>
            )}
          </li>
        ))}
      </ol>
      <form
        noValidate
        aria-label="Send a message"
        className="space-y-1"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <label htmlFor="chat-input" className="block text-sm font-medium">
          Message
        </label>
        <div className="flex gap-2">
          <input
            id="chat-input"
            name="body"
            type="text"
            autoComplete="off"
            maxLength={CHAT_BODY_MAX_LENGTH}
            disabled={!canSend}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setInvalid(false);
            }}
            className="w-full rounded-full border border-line bg-surface px-4 py-1.5 transition hover:bg-surface-strong disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!canSend}
            className="rounded-full bg-focus px-4 py-2 font-medium text-focus-ink shadow-glow transition hover:brightness-110 disabled:opacity-50"
          >
            Send
          </button>
        </div>
        <p className="text-xs text-muted">
          {`${String(draft.length)} / ${String(CHAT_BODY_MAX_LENGTH)}`}
          {!canSend && ' · Chat is unavailable until the room is connected.'}
        </p>
        {invalid && (
          <p role="alert" className="text-sm text-danger">
            {INVALID_CHAT_BODY}
          </p>
        )}
      </form>
    </section>
  );
}
