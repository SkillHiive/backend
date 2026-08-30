require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { AccessToken } = require("livekit-server-sdk");
const { createClient } = require("@supabase/supabase-js");
const {
  initTimeTrackerSync,
  handleManualSync,
} = require("./timeTrackerSync");

const requiredEnvVars = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Time-tracker sync engine (Wakatime/Hackatime): manual endpoint + daily cron.
const cleanupTimeTracker = initTimeTrackerSync(supabase);
app.post("/sync-time-trackers", handleManualSync);

const PORT = process.env.PORT || 3000;
let server;

function createServer() {
  return app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

function gracefulShutdown(signal) {
  console.log(`Received ${signal}. Starting graceful shutdown...`);
  
  if (cleanupTimeTracker) {
    try {
      cleanupTimeTracker();
      console.log('Time tracker cron stopped');
    } catch (err) {
      console.error('Error stopping time tracker cron:', err);
    }
  }
  
  if (server) {
    server.close((err) => {
      if (err) {
        console.error('Error during server close:', err);
        process.exit(1);
      }
      console.log('Server closed. Exiting process.');
      process.exit(0);
    });

    setTimeout(() => {
      console.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10000);
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

server = createServer();

app.get("/health", (req, res) => {
  res.status(200).json({ 
    status: "ok", 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    pid: process.pid
  });
});

app.get("/getToken", async (req, res) => {
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
    console.error(err);
    res.status(500).json({ error: "failed to generate token" });
  }
});
