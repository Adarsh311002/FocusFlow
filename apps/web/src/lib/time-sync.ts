// Client clock offset (docs/architecture/focus-timing-protocol.md, "Client display").
// The server's clock (Redis TIME) is authoritative; the client only estimates how far its
// own clock is from it, to *display* countdowns. It never decides that anything ended.
//
// One `time:sync` round trip gives: t0 (client send), serverNowMs, t1 (client receive).
// Assuming the request and the reply took equally long, the server read its clock at the
// client's (t0 + t1) / 2, so offset ≈ serverNowMs − (t0 + t1) / 2. The sample with the
// shortest round trip has the least room for asymmetry, so it is the one trusted.

export type ClockSample = { readonly offsetMs: number; readonly roundTripMs: number };

export const sampleFromRoundTrip = (
  clientSentAtMs: number,
  serverNowMs: number,
  clientReceivedAtMs: number,
): ClockSample => ({
  offsetMs: serverNowMs - (clientSentAtMs + clientReceivedAtMs) / 2,
  roundTripMs: clientReceivedAtMs - clientSentAtMs,
});

/** How many recent samples are kept; older ones age out so a changed network is noticed. */
const MAX_SAMPLES = 8;

export type Clock = {
  /** Records one round trip; negative round trips (the client clock jumped) are ignored. */
  readonly addSample: (sample: ClockSample) => void;
  /** The best current estimate, or 0 before the first sample. */
  readonly offsetMs: () => number;
  /** The server's current time, as best the client can tell. */
  readonly serverNow: () => number;
  readonly hasSamples: () => boolean;
  readonly reset: () => void;
};

export const createClock = (now: () => number = Date.now): Clock => {
  let samples: ClockSample[] = [];

  const best = (): ClockSample | undefined =>
    samples.reduce<ClockSample | undefined>(
      (chosen, sample) =>
        chosen === undefined || sample.roundTripMs < chosen.roundTripMs ? sample : chosen,
      undefined,
    );

  const offsetMs = (): number => best()?.offsetMs ?? 0;

  return {
    addSample: (sample) => {
      if (sample.roundTripMs < 0 || !Number.isFinite(sample.offsetMs)) {
        return;
      }
      samples = [...samples, sample].slice(-MAX_SAMPLES);
    },
    offsetMs,
    serverNow: () => now() + offsetMs(),
    hasSamples: () => samples.length > 0,
    reset: () => {
      samples = [];
    },
  };
};

/** The app's clock; the realtime client feeds it from `time:sync`. */
export const clock = createClock();
