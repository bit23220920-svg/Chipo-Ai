// ratelimit.js
//
// A small in-memory rate limiter, so guessing passwords or flooding Chipo
// costs an attacker time instead of costing the server its CPU.
//
// It keeps its counts inside this one process. That is fine for a single
// server (the Docker setup in this repo). If Chipo is ever run as several
// copies behind a load balancer, swap the Map for a shared store such as Redis.
//
// Behind a proxy (Caddy in this repo) set TRUST_PROXY=1 so req.ip is the
// visitor and not the proxy. Set RATE_LIMIT_DISABLED=true to switch all of it
// off, for example when load testing.

const buckets = new Map(); // key -> { count, resetAt }

function disabled() {
  return String(process.env.RATE_LIMIT_DISABLED || '').toLowerCase() === 'true';
}

function peek(key, now = Date.now()) {
  const bucket = buckets.get(key);
  if (!bucket) return 0;
  if (bucket.resetAt <= now) {
    buckets.delete(key);
    return 0;
  }
  return bucket.count;
}

function hit(key, windowMs, now = Date.now()) {
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return 1;
  }
  bucket.count += 1;
  return bucket.count;
}

function retryAfterSeconds(key, now = Date.now()) {
  const bucket = buckets.get(key);
  return bucket ? Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) : 1;
}

function tooMany(res, key, message) {
  res.set('Retry-After', String(retryAfterSeconds(key)));
  return res.status(429).json({ error: message || 'Too many requests. Please wait a moment and try again.' });
}

// Drop expired entries now and then so the Map cannot grow without limit.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, 5 * 60 * 1000);
sweeper.unref();

/** Counts every request. `key` picks who is being counted (default: the IP). */
function rateLimit({ name, windowMs, max, key = (req) => req.ip, message }) {
  return (req, res, next) => {
    if (disabled()) return next();
    const bucketKey = `${name}:${key(req)}`;
    if (hit(bucketKey, windowMs) > max) return tooMany(res, bucketKey, message);
    return next();
  };
}

/**
 * Counts only failed sign-ins (a 401 response), per IP and per account name,
 * so a real user who types their password right is never slowed down, while
 * someone guessing is stopped after a few tries. A successful sign-in clears
 * that account's own counter.
 */
function failedLogins({ name, windowMs = 15 * 60 * 1000, maxPerAccount = 8, maxPerIp = 40, account }) {
  return (req, res, next) => {
    if (disabled()) return next();
    const who = String(account(req) || '').toLowerCase().slice(0, 64);
    const accountKey = `${name}:acct:${req.ip}:${who}`;
    const ipKey = `${name}:ip:${req.ip}`;
    if (peek(accountKey) >= maxPerAccount) {
      return tooMany(res, accountKey, 'Too many failed sign-in attempts. Please wait a few minutes and try again.');
    }
    if (peek(ipKey) >= maxPerIp) {
      return tooMany(res, ipKey, 'Too many failed sign-in attempts. Please wait a few minutes and try again.');
    }
    res.on('finish', () => {
      if (res.statusCode === 401) {
        hit(accountKey, windowMs);
        hit(ipKey, windowMs);
      } else if (res.statusCode === 200) {
        buckets.delete(accountKey);
      }
    });
    return next();
  };
}

/** For tests: forget everything counted so far. */
function reset() {
  buckets.clear();
}

module.exports = { rateLimit, failedLogins, reset };
