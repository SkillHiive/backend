/**
 * Prometheus Metrics for SkillHive Backend
 */

const { Registry, Counter, Histogram, Gauge } = require('prom-client');

const register = new Registry();

register.setDefaultLabels({ app: 'skillhive-backend' });

const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'path', 'status'],
  registers: [register],
});

const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'path'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [register],
});

const syncDuration = new Histogram({
  name: 'sync_duration_seconds',
  help: 'Wakatime/Hackatime sync duration in seconds',
  labelNames: ['provider', 'status'],
  buckets: [1, 5, 10, 30, 60, 120, 300],
  registers: [register],
});

const activeConnections = new Gauge({
  name: 'active_connections',
  help: 'Active Wakatime/Hackatime connections',
  labelNames: ['provider'],
  registers: [register],
});

const cronDuration = new Histogram({
  name: 'cron_duration_seconds',
  help: 'Daily cron sync duration in seconds',
  buckets: [10, 30, 60, 120, 300, 600],
  registers: [register],
});

const syncErrorsTotal = new Counter({
  name: 'sync_errors_total',
  help: 'Total sync errors',
  labelNames: ['provider', 'error_type'],
  registers: [register],
});

function metricsMiddleware(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;
    httpRequestsTotal.inc({
      method: req.method,
      path: req.route?.path ?? req.path,
      status: res.statusCode,
    });
    httpRequestDuration.observe(
      { method: req.method, path: req.route?.path ?? req.path },
      duration
    );
  });
  next();
}

function recordSyncDuration(provider, status, duration) {
  syncDuration.observe({ provider, status }, duration);
  if (status !== 'ok') {
    syncErrorsTotal.inc({ provider, error_type: status });
  }
}

function setActiveConnections(provider, count) {
  activeConnections.set({ provider }, count);
}

function recordCronDuration(duration) {
  cronDuration.observe(duration);
}

module.exports = {
  register,
  metricsMiddleware,
  httpRequestsTotal,
  httpRequestDuration,
  syncDuration,
  activeConnections,
  cronDuration,
  syncErrorsTotal,
  recordSyncDuration,
  setActiveConnections,
  recordCronDuration,
};