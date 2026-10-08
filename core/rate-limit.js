// In-memory sliding-window limiter for cheap per-node throttling (message
// sends, uploads, typing). Security-relevant limits that must survive a
// restart or span nodes (sign-in, OTP) are persisted in the DB instead
// (auth_failures, email_otps.attempts).
export function createRateLimiter() {
  const hits = new Map();

  // take(key, max, windowMs) → true if allowed (and counted).
  function take(key, max, windowMs) {
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => t > now - windowMs);
    if (list.length >= max) {
      hits.set(key, list);
      return false;
    }
    list.push(now);
    hits.set(key, list);
    return true;
  }

  // Forget idle keys so the map does not grow without bound.
  const sweeper = setInterval(() => {
    const cutoff = Date.now() - 3600_000;
    for (const [key, list] of hits) if (!list.length || list[list.length - 1] < cutoff) hits.delete(key);
  }, 600_000);
  sweeper.unref();

  return { take, stop: () => clearInterval(sweeper) };
}
