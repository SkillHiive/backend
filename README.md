<img width="1983" height="793" alt="SkillHiive Banner" src="https://github.com/user-attachments/assets/c5f7801e-c4f7-4db1-9f69-f79653b9bccf" />

# SkillHiive Backend

> The trusted services behind SkillHiive.

This repository contains the backend services powering the SkillHiive ecosystem.

It provides the secure infrastructure responsible for authentication, authorization, real-time communication, and integrations that support the SkillHiive platform.

Unlike the frontend, this repository is **not intended to be a standalone application**. It exists to securely power the client applications while keeping sensitive credentials and business logic off the client.

---

## Responsibilities

The backend currently handles:

* Authentication validation (Supabase JWT verification)
* Secure token generation for LiveKit rooms
* Real-time service integrations (LiveKit SFU)
* Time-tracker synchronization (Wakatime / Hackatime)
* REST API endpoints for client consumption
* Backend-only secrets management
* Platform infrastructure (health checks, graceful shutdown, PM2 process management)

As SkillHiive evolves, additional backend services may be introduced while maintaining a modular architecture.

---

## Technology

Current technologies include:

* **Node.js** (>=20 LTS) — Runtime
* **Express** — HTTP server framework
* **Supabase** — Auth, database, and RPC (PostgreSQL)
* **LiveKit Server SDK** — Room token generation
* **PM2** — Production process management
* **REST APIs** — Client communication

The technology stack may evolve as the platform grows.

---

## Local Development

### Prerequisites

* Node.js (Latest LTS recommended, >=20)
* npm
* Supabase project (with `service_role` key)
* LiveKit server (see [livekit-wrapper](../livekit-wrapper))
* Wakatime and/or Hackatime accounts (for time-tracker sync)

### Installation

```bash
git clone https://github.com/SkillHiive/backend.git
cd backend
npm install
```

### Environment Variables

Create a `.env` file containing the required configuration:

```env
# Server
PORT=3000
NODE_ENV=development

# Supabase (service role key for admin operations)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# LiveKit (API key/secret for token generation)
LIVEKIT_API_KEY=your-livekit-api-key
LIVEKIT_API_SECRET=your-livekit-api-secret
```

Never commit your `.env` file or expose service credentials publicly.

### Running Locally

```bash
# Development
npm run dev

# Production-like
npm run start:prod
```

The backend will start on `http://0.0.0.0:3000` (or configured `PORT`).

---

## API Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/health` | None | Health check with uptime, memory, PID |
| `GET` | `/getToken` | Bearer (Supabase JWT) | Generate LiveKit room token |
| `POST` | `/sync-time-trackers` | Bearer (Supabase JWT) | Manual time-tracker sync (query `?force=1` to skip debounce) |

### `/getToken` — LiveKit Room Token

**Query params:** `room` (string), `username` (string)

**Headers:** `Authorization: Bearer <supabase-jwt>`

**Response:** `{ "token": "<livekit-jwt>" }`

Validates the Supabase session, confirms the username matches the authenticated user's profile, then issues a LiveKit access token with `roomJoin`, `canPublish`, and `canSubscribe` grants.

### `/sync-time-trackers` — Time Tracker Sync

**Headers:** `Authorization: Bearer <supabase-jwt>`

**Query:** `?force=1` (optional — bypasses 5-minute debounce)

Syncs the authenticated user's Wakatime/Hackatime connections. Fetches projects, daily breakdowns (90-day lookback), and language distributions, then upserts to `time_tracker_projects_raw` and calls `reaggregate_tracker_time` RPC.

---

## Time Tracker Sync Engine

Runs inside the Express server:

* **Daily cron** — 03:00 UTC, syncs all active connections
* **Manual endpoint** — `POST /sync-time-trackers` per-user with 5-minute debounce
* **Providers:** Wakatime (full API) + Hackatime (compat + native endpoints)
* **Storage:** `time_tracker_connections` (config), `time_tracker_projects_raw` (daily series), aggregated via `reaggregate_tracker_time` RPC

See `timeTrackerSync.js` for implementation details.

---

## Production Deployment

### PM2 (Recommended)

```bash
# Start
npm run start:pm2

# Logs
npm run pm2:logs

# Restart
npm run pm2:restart

# Stop
npm run pm2:stop
```

Configuration: `ecosystem.config.js`

### Docker

```bash
docker build -t skillhive-backend .
docker run -p 3000:3000 --env-file .env skillhive-backend
```

### Graceful Shutdown

Handles `SIGTERM`/`SIGINT` with:
* Cron cleanup
* HTTP server close (10s timeout)
* Process exit

---

## Project Structure

```
backend/
├── server.js              # Express app, routes, middleware, lifecycle
├── timeTrackerSync.js     # Wakatime/Hackatime sync engine + cron
├── ecosystem.config.js    # PM2 process configuration
├── Dockerfile             # Container image
├── .dockerignore
├── package.json
└── LICENSE
```

---

## Engineering Expectations

When contributing here, optimize for long-term platform reliability:

* Keep secrets strictly server-side — never expose in client bundles
* Validate authentication before any privileged operation
* Prefer short-lived tokens over long-lived credentials
* Maintain clear separation: auth validation, business logic, external integrations
* Handle errors explicitly; log with context for debugging
* Document any behavior that frontend teams need to mirror

---

## Cross-Repo Contribution Workflow (Backend + Web + Mobile)

For any non-trivial change, ask and answer in your PR:

1. Does this change alter shared API contracts or auth flows?
2. Does the Web/Mobile version need a matching implementation or follow-up issue?
3. Are data-shape assumptions still valid for all clients?
4. Are error codes and response formats consistent?

This habit keeps SkillHiive coherent as one product.

---

## Pull Requests

A strong PR in this repository includes:

* Clear problem statement and impact
* Notes about frontend implications when relevant
* Migration notes for breaking API changes
* Explicit follow-up tasks when parity is deferred
* Updated environment variable documentation if new secrets added

---

## Security

This repository handles sensitive operations:

* Secrets remain server-side only
* Authentication verified before privileged operations
* Short-lived tokens preferred (LiveKit JWTs, Supabase JWTs)
* Client applications never receive backend service secrets
* Service-role Supabase key used only for admin operations

If you discover a security vulnerability, please refer to our Security Policy.

---

## License

Licensed under the **GNU Affero General Public License v3.0 (AGPLv3)**.

See the [LICENSE](LICENSE) file for details.

---

## About SkillHiive

SkillHiive is building communities around presence instead of performance.

No algorithms.
No performance systems.
Just real people, real connections, and meaningful work.

Learn more about the project through the SkillHiive organization.