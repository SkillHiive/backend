require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const { AccessToken } = require("livekit-server-sdk");
const crypto = require("crypto");

const {
  initTimeTrackerSync,
  handleManualSync,
} = require("./timeTrackerSync");

const { rateLimitToken, rateLimitSync, rateLimitGetToken } = require("./src/middleware/rateLimit");
const { metricsMiddleware, register, recordSyncDuration, setActiveConnections } = require("./src/metrics");
const { logger } = require("./src/logger");
const { setupCueSyncProxy } = require("./src/proxy/cueSync");

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

app.get("/getToken", rateLimitGetToken, async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      return res.sendStatus(200);
    }

    const room = req.query.room;
    const username = req.query.username;

    if (!room || !username) {
      return res.status(400).json({ error: "room and username are required" });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const sessionToken = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(sessionToken);

    if (authError || !user) {
      return res.status(401).json({ error: "invalid session" });
    }

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("username")
      .eq("id", user.id)
      .single();

    if (profileError || !profile) {
      return res.status(401).json({ error: "profile not found" });
    }

    if (profile.username !== username) {
      return res.status(403).json({ error: "username mismatch" });
    }

    const at = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      { identity: username }
    );

    at.addGrant({
      roomJoin: true,
      room,
      canPublish: true,
      canSubscribe: true,
    });

    const token = await at.toJwt();
    res.json({ token });
  } catch (err) {
    logger.error("getToken error", { error: err.message });
    res.status(500).json({ error: "failed to generate token" });
  }
});

server = createServer();