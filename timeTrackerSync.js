// Time-tracker sync engine (Wakatime + Hackatime) for SkillHive.
//
// Runs inside the existing Express server:
//   POST /sync-time-trackers          — per-user manual sync (Supabase JWT auth,
//                                       5-min debounce unless ?force=1)
//   internal daily tick @ 03:00 UTC   — syncs every active connection
//
// Replaces the hosted-Supabase Edge Function variant for self-hosted deploys.

const LOOKBACK_DAYS = 90;
const MANUAL_DEBOUNCE_MS = 5 * 60 * 1000;
const CRON_HOUR_UTC = 3;

let supabaseAdmin = null;
let lastCronDay = null;
let cronTimer = null;

/** Wire the engine to a service-role Supabase client + start the daily cron. */
function initTimeTrackerSync(adminClient) {
  supabaseAdmin = adminClient;
  if (cronTimer) clearInterval(cronTimer);
  cronTimer = setInterval(() => {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (now.getUTCHours() === CRON_HOUR_UTC && lastCronDay !== day) {
      lastCronDay = day;
      syncAllConnections().catch((err) =>
        console.error("[timeTracker] daily sync failed:", err.message)
      );
    }
  }, 60 * 1000);
}

// ── Unified tracker client ──────────────────────────────────────────────────
//
// The providers differ in auth scheme AND route layout (verified live):
//   Wakatime  https://wakatime.com/api/v1
//               auth: Basic base64(api_key)
//               /users/current · /users/current/projects
//               /users/current/summaries · /users/current/all_time_since_today
//   Hackatime compat layer  https://hackatime.hackclub.com/api/hackatime/v1
//               auth: Bearer api_key (Basic tried as legacy fallback)
//               /users/current · /users/current/summaries   (nothing else)
//   Hackatime native        https://hackatime.hackclub.com/api/v1
//               /authenticated/projects                     (project listing)
//
// No all-time-per-project endpoint exists on Hackatime, so totals there are
// derived from the 90-day summaries (fetchProject already handles that).

const WAKATIME_BASE = "https://wakatime.com/api/v1";
const HACKATIME_COMPAT_BASE = "https://hackatime.hackclub.com/api/hackatime/v1";
const HACKATIME_NATIVE_BASE = "https://hackatime.hackclub.com/api/v1";

class TimeTrackerClient {
  constructor(provider, apiKey) {
    this.provider = provider;
    this.schemes =
      provider === "hackatime"
        ? [`Bearer ${apiKey}`, `Basic ${Buffer.from(apiKey).toString("base64")}`]
        : [`Basic ${Buffer.from(apiKey).toString("base64")}`];
    this.resolvedScheme = null;
    this.lastErrorDetail = null;
  }

  async testConnection() {
    const res = await this.get(`${this.#summariesBase()}/users/current`);
    return res?.ok === true;
  }

  async listProjects() {
    const url =
      this.provider === "hackatime"
        ? `${HACKATIME_NATIVE_BASE}/authenticated/projects`
        : `${WAKATIME_BASE}/users/current/projects`;

    const res = await this.get(url);
    if (res?.ok) {
      const body = await res.json();
      const rows = Array.isArray(body?.data) ? body.data : [];
      const names = rows
        .map((row) =>
          typeof row === "string" ? row : row?.name ?? row?.id ?? null
        )
        .filter(Boolean);
      if (names.length > 0) return names;
    }
    // Fallback for either provider: derive active projects from summaries.
    return this.projectNamesFromSummaries();
  }

  async getAllTimeSeconds(projectName) {
    // Wakatime only; Hackatime callers fall back to the daily sum.
    if (this.provider !== "wakatime") return null;
    const url = `${WAKATIME_BASE}/users/current/all_time_since_today?project=${encodeURIComponent(
      projectName
    )}`;
    const res = await this.get(url);
    if (!res?.ok) return null;
    const body = await res.json();
    const raw = body?.data?.total_seconds;
    if (raw == null) return null;
    return typeof raw === "string" ? Number(raw) : raw;
  }

  /**
   * Daily summaries covering every project at once; per-project seconds come
   * from data[].projects[], day-level languages are distributed across that
   * day's active projects by share of tracked time.
   */
  async getDailyBreakdown(projectName, days = LOOKBACK_DAYS) {
    const end = new Date();
    const start = new Date(end.getTime() - days * 86400000);
    const url = `${this.#summariesBase()}/users/current/summaries?start=${isoDate(
      start
    )}&end=${isoDate(end)}`;
    let entries;
    try {
      const res = await this.get(url);
      if (!res?.ok) return { daily: [], languages: [] };
      const body = await res.json();
      entries = Array.isArray(body?.data) ? body.data : [];
    } catch {
      return { daily: [], languages: [] };
    }

    const daily = [];
    const langTotals = new Map();

    for (let idx = 0; idx < entries.length; idx++) {
      const entry = entries[idx];
      const date = isoDate(new Date(start.getTime() + idx * 86400000)).slice(0, 10);
      const mine = entry.projects?.find((p) => p.name === projectName);
      const daySeconds = mine?.total_seconds ?? 0;
      if (daySeconds > 0) daily.push({ date, seconds: Math.round(daySeconds) });

      const dayLangs = entry.languages ?? [];
      const dayTotal = entry.grand_total?.total_seconds ?? 0;
      if (daySeconds > 0 && dayTotal > 0 && dayLangs.length > 0) {
        const share = daySeconds / dayTotal;
        for (const l of dayLangs) {
          const secs = (l.total_seconds ?? 0) * share;
          if (secs <= 0) continue;
          langTotals.set(l.name, (langTotals.get(l.name) ?? 0) + secs);
        }
      }
    }

    const languages = [...langTotals.entries()]
      .map(([name, total]) => ({ name, total_seconds: Math.round(total) }))
      .sort((a, b) => b.total_seconds - a.total_seconds);

    return { daily, languages };
  }

  async fetchProject(name) {
    const [allTime, breakdown] = await Promise.all([
      this.getAllTimeSeconds(name),
      this.getDailyBreakdown(name),
    ]);
    if (allTime == null && breakdown.daily.length === 0) return null;

    const lastDay = breakdown.daily.length
      ? breakdown.daily[breakdown.daily.length - 1].date
      : null;
    return {
      tracker_project_id: name,
      name,
      total_seconds:
        allTime ?? breakdown.daily.reduce((acc, d) => acc + d.seconds, 0),
      languages: breakdown.languages,
      daily: breakdown.daily,
      last_coded_at: lastDay ? `${lastDay}T00:00:00Z` : null,
    };
  }

  /** Try each auth scheme until one answers OK; lock it in for the session. */
  async get(url) {
    const schemes = this.resolvedScheme ? [this.resolvedScheme] : this.schemes;
    const failures = [];

    for (const authorization of schemes) {
      try {
        const res = await fetch(url, {
          headers: { Authorization: authorization, "User-Agent": "skillhive-sync/1.0" },
        });
        if (res.ok) {
          this.resolvedScheme = authorization;
          this.lastErrorDetail = null;
          return res;
        }
        failures.push(`${res.status} via ${this.masked(authorization)}`);
      } catch (err) {
        failures.push(`network error via ${this.masked(authorization)}: ${err?.message}`);
      }
    }
    this.lastErrorDetail = failures.join("; ");
    return null;
  }

  #summariesBase() {
    return this.provider === "hackatime" ? HACKATIME_COMPAT_BASE : WAKATIME_BASE;
  }

  masked(authorization) {
    return authorization.startsWith("Bearer") ? "Bearer …" : "Basic …";
  }

  async projectNamesFromSummaries() {
    const end = new Date();
    const start = new Date(end.getTime() - LOOKBACK_DAYS * 86400000);
    const res = await this.get(
      `${this.#summariesBase()}/users/current/summaries?start=${isoDate(start)}&end=${isoDate(end)}`
    );
    if (!res?.ok) return [];
    const body = await res.json();
    const names = new Set();
    for (const entry of body?.data ?? []) {
      for (const p of entry.projects ?? []) {
        if (p.name) names.add(p.name);
      }
    }
    return [...names];
  }
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

// ── Sync orchestration ──────────────────────────────────────────────────────

async function syncConnection(conn) {
  try {
    const client = new TimeTrackerClient(conn.provider, String(conn.api_key ?? "").trim());
    if (!(await client.testConnection())) {
      throw new Error(
        `api key rejected by ${conn.provider} tracker${
          client.lastErrorDetail ? ` (${client.lastErrorDetail})` : ""
        }`
      );
    }

    const projects = await client.listProjects();
    let synced = 0;

    for (const p of projects) {
      const tracked = await client.fetchProject(p.name);
      if (!tracked) continue;
      const { error } = await supabaseAdmin
        .from("time_tracker_projects_raw")
        .upsert(
          {
            user_id: conn.user_id,
            connection_id: conn.user_id,
            tracker_project_id: tracked.tracker_project_id,
            name: tracked.name,
            total_seconds: Math.round(tracked.total_seconds),
            languages: tracked.languages,
            daily: tracked.daily,
            last_coded_at: tracked.last_coded_at,
            synced_at: new Date().toISOString(),
          },
          { onConflict: "connection_id,tracker_project_id" }
        );
      if (error) throw new Error(`raw upsert failed: ${error.message}`);
      synced++;
    }

    const { error: aggError } = await supabaseAdmin.rpc("reaggregate_tracker_time", {
      p_user_id: conn.user_id,
    });
    if (aggError) throw new Error(`reaggregate failed: ${aggError.message}`);

    await supabaseAdmin
      .from("time_tracker_connections")
      .update({
        status: "active",
        last_sync_at: new Date().toISOString(),
        last_error: null,
      })
      .eq("user_id", conn.user_id);

    return { user_id: conn.user_id, ok: true, projects_synced: synced };
  } catch (err) {
    const message = err?.message ?? String(err);
    await supabaseAdmin
      .from("time_tracker_connections")
      .update({ status: "error", last_error: message })
      .eq("user_id", conn.user_id);
    return { user_id: conn.user_id, ok: false, error: message };
  }
}

/**
 * @param {string|null} userId  restrict to one user (manual sync)
 * @param {boolean} includeErrored  manual retries must see failed connections,
 * otherwise an errored row can never be synced again (stuck-state bug).
 */
async function loadConnections(userId, includeErrored = false) {
  let query = supabaseAdmin
    .from("time_tracker_connections")
    .select("user_id, provider, api_key, last_sync_at");
  if (includeErrored) {
    query = query.in("status", ["active", "error"]);
  } else {
    query = query.eq("status", "active");
  }
  if (userId) query = query.eq("user_id", userId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data ?? [];
}

async function syncAllConnections() {
  const connections = await loadConnections(null);
  const results = [];
  for (const conn of connections) {
    const result = await syncConnection(conn);
    console.log(
      `[timeTracker] cron sync user=${conn.user_id} provider=${conn.provider} ` +
        (result.ok ? "ok" : `FAILED: ${result.error}`)
    );
    results.push(result);
  }
  return results;
}

function isDebounced(lastSyncAt) {
  if (!lastSyncAt) return false;
  return Date.now() - new Date(lastSyncAt).getTime() < MANUAL_DEBOUNCE_MS;
}

/** Express handler: POST /sync-time-trackers (?force=1 skips debounce) */
async function handleManualSync(req, res) {
  try {
    if (!supabaseAdmin) {
      return res.status(500).json({ error: "engine not initialised" });
    }

    const authHeader = req.headers.authorization ?? "";
    const token = authHeader.replace("Bearer ", "").trim();
    if (!token) return res.status(401).json({ error: "unauthorized" });

    const {
      data: { user },
      error: authError,
    } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: "invalid session" });

    const force = req.query.force === "1";
    // includeErrored: a previously-failed connection must be retryable here.
    const connections = await loadConnections(user.id, true);
    if (connections.length === 0) {
      return res.status(200).json({ synced: 0, results: [] });
    }

    const results = [];
    for (const conn of connections) {
      if (!force && isDebounced(conn.last_sync_at)) {
        results.push({ user_id: conn.user_id, ok: false, skipped: true });
        continue;
      }
      const result = await syncConnection(conn);
      console.log(
        `[timeTracker] manual sync user=${conn.user_id} provider=${conn.provider} ` +
          (result.ok
            ? `ok projects=${result.projects_synced}`
            : `FAILED: ${result.error}`)
      );
      results.push(result);
    }

    res.json({
      synced: results.filter((r) => r.ok).length,
      results,
    });
  } catch (err) {
    console.error("[timeTracker] manual sync failed:", err?.message);
    res.status(500).json({ error: err?.message ?? "sync failed" });
  }
}

module.exports = { initTimeTrackerSync, handleManualSync, TimeTrackerClient };
