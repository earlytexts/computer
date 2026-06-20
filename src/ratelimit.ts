/**
 * Per-client token-bucket rate limiting. Each key (normally a client IP)
 * gets `burst` tokens, refilled at `ratePerSecond`; a request spends one.
 * A non-positive rate disables limiting entirely.
 */

export type RateLimiterOptions = {
  ratePerSecond: number;
  burst: number;
};

export type RateLimiter = {
  /** Returns true if the request is allowed, false if it should be rejected. */
  allow: (key: string, nowMs?: number) => boolean;
};

type Bucket = { tokens: number; last: number };

/** Buckets are pruned (full ones dropped) when the table exceeds this. */
const MAX_BUCKETS = 10_000;

export const createRateLimiter = (
  { ratePerSecond, burst }: RateLimiterOptions,
): RateLimiter => {
  const buckets = new Map<string, Bucket>();

  const allow = (key: string, nowMs = Date.now()): boolean => {
    if (ratePerSecond <= 0) return true;
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = { tokens: burst, last: nowMs };
      buckets.set(key, bucket);
    } else {
      const elapsed = Math.max(0, nowMs - bucket.last) / 1000;
      bucket.tokens = Math.min(burst, bucket.tokens + elapsed * ratePerSecond);
      bucket.last = nowMs;
    }
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    if (buckets.size > MAX_BUCKETS) {
      for (const [k, b] of buckets) {
        const idle = (nowMs - b.last) / 1000;
        if (b.tokens + idle * ratePerSecond >= burst) buckets.delete(k);
      }
    }
    return true;
  };

  return { allow };
};

/**
 * The key identifying a client: the first X-Forwarded-For hop if present
 * (set by a reverse proxy, or by davidhume forwarding its visitor's IP),
 * otherwise the connection's remote address.
 */
export const clientKey = (req: Request, remoteAddr?: string): string => {
  const forwarded = req.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0].trim();
  return first !== undefined && first !== "" ? first : remoteAddr ?? "unknown";
};
