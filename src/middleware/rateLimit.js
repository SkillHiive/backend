/**
 * Rate Limiting Middleware for SkillHive Backend
 * Uses rate-limiter-flexible for in-memory rate limiting
 */

const { RateLimiterMemory } = require('rate-limiter-flexible');

const tokenLimiter = new RateLimiterMemory({
  points: 30,
  duration: 60,
  blockDuration: 60,
});

const syncLimiter = new RateLimiterMemory({
  points: 10,
  duration: 300,
  blockDuration: 300,
});

const getTokenLimiter = new RateLimiterMemory({
  points: 5,
  duration: 60,
  blockDuration: 60,
});

async function rateLimitMiddleware(req, res, next, limiter, keyPrefix = '') {
  try {
    const key = `${keyPrefix}${req.ip || 'unknown'}`;
    await limiter.consume(key);
    next();
  } catch (rejRes) {
    const retryAfter = Math.ceil(rejRes.msBeforeNext / 1000) || 1;
    res.set('Retry-After', String(retryAfter));
    res.status(429).json({
      error: 'Too many requests',
      retryAfter,
    });
  }
}

const rateLimitToken = (req, res, next) =>
  rateLimitMiddleware(req, res, next, tokenLimiter, 'token:');

const rateLimitSync = (req, res, next) =>
  rateLimitMiddleware(req, res, next, syncLimiter, 'sync:');

const rateLimitGetToken = (req, res, next) =>
  rateLimitMiddleware(req, res, next, getTokenLimiter, 'gettoken:');

module.exports = { rateLimitToken, rateLimitSync, rateLimitGetToken };