class GovernorRateLimitError extends Error {
  constructor(retryAfterMs, global = false) {
    super(`Discord rate limit; retry after ${retryAfterMs}ms`);
    this.name = 'DiscordRateLimitError';
    this.retryAfterMs = retryAfterMs;
    this.global = global;
  }
}

class RestTrafficGovernor {
  constructor({ fetchImpl = fetch, maxPerSecond = 4, burst = 2, maxFailures = 3, circuitMs = 60_000 } = {}) {
    this.fetchImpl = fetchImpl;
    this.maxPerSecond = maxPerSecond;
    this.tokens = burst;
    this.burst = burst;
    this.lastRefillAt = Date.now();
    this.routeBlockedUntil = new Map();
    this.globalBlockedUntil = 0;
    this.failureCount = 0;
    this.maxFailures = maxFailures;
    this.circuitMs = circuitMs;
    this.circuitOpenUntil = 0;
  }

  refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefillAt) / 1000;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.maxPerSecond);
    this.lastRefillAt = now;
  }

  async waitForSlot(route) {
    while (true) {
      const now = Date.now();
      const blockedUntil = Math.max(this.globalBlockedUntil, this.routeBlockedUntil.get(route) || 0, this.circuitOpenUntil);
      this.refill();
      if (now >= blockedUntil && this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const tokenWait = this.tokens >= 1 ? 0 : ((1 - this.tokens) / this.maxPerSecond) * 1000;
      const cooldownWait = Math.max(0, blockedUntil - now);
      await new Promise((resolve) => setTimeout(resolve, Math.max(50, Math.min(60_000, tokenWait || cooldownWait || 250))));
    }
  }

  parseRetryAfter(headers, bodyText) {
    const values = [Number(headers.get('retry-after')) * 1000, Number(headers.get('x-ratelimit-reset-after')) * 1000];
    try { values.push(Number(JSON.parse(bodyText).retry_after) * 1000); } catch (_) {}
    const valid = values.filter((value) => Number.isFinite(value) && value > 0);
    return Math.max(1_000, Math.ceil(valid.length ? Math.max(...valid) : 60_000));
  }

  isGlobal(headers, bodyText) {
    if (String(headers.get('x-ratelimit-global')).toLowerCase() === 'true') return true;
    if (String(headers.get('x-ratelimit-scope')).toLowerCase() === 'global') return true;
    try { return JSON.parse(bodyText).global === true; } catch (_) { return /global rate limit|blocked from accessing our API/i.test(bodyText); }
  }

  async request(url, options = {}, route = url) {
    await this.waitForSlot(route);
    const response = await this.fetchImpl(url, options);
    if (response.ok) {
      this.failureCount = 0;
      this.routeBlockedUntil.delete(route);
      return response;
    }

    const bodyText = await response.text().catch(() => '');
    if (response.status === 429) {
      const retryAfterMs = this.parseRetryAfter(response.headers, bodyText);
      const global = this.isGlobal(response.headers, bodyText);
      const until = Date.now() + retryAfterMs;
      if (global) this.globalBlockedUntil = Math.max(this.globalBlockedUntil, until);
      else this.routeBlockedUntil.set(route, Math.max(this.routeBlockedUntil.get(route) || 0, until));
      throw new GovernorRateLimitError(retryAfterMs, global);
    }

    if ([502, 503, 504].includes(response.status)) {
      this.failureCount += 1;
      if (this.failureCount >= this.maxFailures) this.circuitOpenUntil = Date.now() + this.circuitMs;
    }
    return response;
  }

  snapshot() {
    this.refill();
    return {
      tokens: Number(this.tokens.toFixed(2)),
      maxPerSecond: this.maxPerSecond,
      globalBlockedUntil: this.globalBlockedUntil,
      openCircuitUntil: this.circuitOpenUntil,
      blockedRoutes: this.routeBlockedUntil.size,
      failures: this.failureCount,
    };
  }
}

module.exports = { RestTrafficGovernor, GovernorRateLimitError };
