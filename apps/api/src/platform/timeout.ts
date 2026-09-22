/**
 * Resolves with `fallback` when `promise` has not settled within `timeoutMs`.
 * Used by the readiness probes: a hanging dependency must never hang the response.
 */
export const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      resolve(fallback);
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, expiry]);
  } finally {
    clearTimeout(timer);
  }
};
