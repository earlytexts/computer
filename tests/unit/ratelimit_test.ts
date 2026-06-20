import { assert, assertEquals } from "@std/assert";
import { clientKey, createRateLimiter } from "../../src/lib/serve/ratelimit.ts";

Deno.test("a burst is allowed, then requests are rejected", () => {
  const limiter = createRateLimiter({ ratePerSecond: 1, burst: 3 });
  const t = 1_000_000;
  assert(limiter.allow("a", t));
  assert(limiter.allow("a", t));
  assert(limiter.allow("a", t));
  assert(!limiter.allow("a", t));
});

Deno.test("tokens refill over time at the configured rate", () => {
  const limiter = createRateLimiter({ ratePerSecond: 2, burst: 2 });
  const t = 1_000_000;
  assert(limiter.allow("a", t));
  assert(limiter.allow("a", t));
  assert(!limiter.allow("a", t));
  // half a second restores one token at 2/s
  assert(limiter.allow("a", t + 500));
  assert(!limiter.allow("a", t + 500));
});

Deno.test("keys are limited independently", () => {
  const limiter = createRateLimiter({ ratePerSecond: 1, burst: 1 });
  const t = 1_000_000;
  assert(limiter.allow("a", t));
  assert(!limiter.allow("a", t));
  assert(limiter.allow("b", t));
});

Deno.test("a non-positive rate disables limiting", () => {
  const limiter = createRateLimiter({ ratePerSecond: 0, burst: 1 });
  const t = 1_000_000;
  for (let i = 0; i < 100; i++) assert(limiter.allow("a", t));
});

Deno.test("clientKey prefers the first X-Forwarded-For hop", () => {
  const forwarded = new Request("http://x/", {
    headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
  });
  assertEquals(clientKey(forwarded, "10.0.0.2"), "203.0.113.7");
  const direct = new Request("http://x/");
  assertEquals(clientKey(direct, "10.0.0.2"), "10.0.0.2");
  assertEquals(clientKey(direct), "unknown");
});
