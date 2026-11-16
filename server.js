require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const { AccessToken, RoomServiceClient } = require("livekit-server-sdk");
const crypto = require("crypto");

const {
  initTimeTrackerSync,
  handleManualSync,
} = require("./timeTrackerSync");

const { rateLimitToken, rateLimitSync, rateLimitGetToken } = require("./src/middleware/rateLimit");
const { metricsMiddleware, register, recordSyncDuration, setActiveConnections } = require("./src/metrics");
const { logger } = require("./src/logger");
const { setupCueSyncProxy } = require("./src/proxy/cueSync");
const rooms = require("./src/rooms");

const requiredEnvVars = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    logger.error(`Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

const app = express();

app.use(cors());
app.use(express.json());
app.use(metricsMiddleware);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const cleanupTimeTracker = initTimeTrackerSync(supabase);
app.post("/sync-time-trackers", rateLimitSync, handleManualSync);

setupCueSyncProxy(app, supabase);

const PORT = process.env.PORT || 3000;
let server;

function createServer() {
  return app.listen(PORT, "0.0.0.0", () => {
    logger.info(`Server running on http://0.0.0.0:${PORT}`);
  });
}

function gracefulShutdown(signal) {
  logger.info(`Received ${signal}. Starting graceful shutdown...`);

  if (cleanupTimeTracker) {
    try {
      cleanupTimeTracker();
      logger.info('Time tracker cron stopped');
    } catch (err) {
      logger.error('Error stopping time tracker cron', { error: err.message });
    }
  }

  if (server) {
    server.close((err) => {
      if (err) {
        logger.error('Error during server close', { error: err.message });
        process.exit(1);
      }
      logger.info('Server closed. Exiting process.');
      process.exit(0);
    });

    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10000);
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception', { error: err.message, stack: err.stack });
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection', { reason: String(reason) });
});

app.get("/health", async (req, res) => {
  try {
    const checks = await Promise.allSettled([
      supabase.from('profiles').select('id').limit(1),
    ]);

    const db = checks[0].status === 'fulfilled' && checks[0].value;

    res.status(db ? 200 : 503).json({
      ok: db,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      pid: process.pid,
      dependencies: { database: db },
    });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

app.get("/metrics", async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.send(await register.metrics());
});

// LiveKit room service: creates rooms with a participant cap and lists who is inside.
const livekit = new RoomServiceClient(
  process.env.LIVEKIT_URL || "https://rooms.skillhiive.com",
  process.env.LIVEKIT_API_KEY,
  process.env.LIVEKIT_API_SECRET
);

async function issueToken(identity, room) {
  const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, { identity });
  at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true });
  return at.toJwt();
}

const roomDeps = () => ({
  supabase,
  livekit,
  issueToken,
  now: () => Date.now(),
  cap: rooms.roomCap(process.env.ROOM_CAP),
  randomHex: (bytes) => crypto.randomBytes(bytes).toString("hex"),
});

function send(res, result) {
  res.status(result.status).json(result.body);
}

// POST { room } is the way to ask. GET ?room= stays for one release; a username in either is ignored.
app.post("/getToken", rateLimitGetToken, async (req, res) => {
  try {
    send(res, await rooms.getToken({ ...roomDeps(), authHeader: req.headers.authorization, room: req.body && req.body.room }));
  } catch (err) {
    logger.error("getToken error", { error: err.message });
    res.status(500).json({ error: "failed to generate token" });
  }
});

app.get("/getToken", rateLimitGetToken, async (req, res) => {
  try {
    send(res, await rooms.getToken({ ...roomDeps(), authHeader: req.headers.authorization, room: req.query.room }));
  } catch (err) {
    logger.error("getToken error", { error: err.message });
    res.status(500).json({ error: "failed to generate token" });
  }
});

app.post("/cubicle", rateLimitGetToken, async (req, res) => {
  try {
    const body = req.body || {};
    send(res, await rooms.createCubicle({ ...roomDeps(), authHeader: req.headers.authorization, room: body.room, target: body.target }));
  } catch (err) {
    logger.error("cubicle error", { error: err.message });
    res.status(500).json({ error: "failed to create cubicle" });
  }
});

server = createServer();