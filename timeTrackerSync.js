// Time-tracker sync engine (Wakatime + Hackatime) for SkillHive.
//
// Runs inside the existing Express server:
//   POST /sync-time-trackers          — per-user manual sync (Supabase JWT auth,
//                                       5-min debounce unless ?force=1)
//   internal daily tick @ 03:00 UTC   — syncs every active connection
//
// Replaces the hosted-Supabase Edge Function variant for self-hosted deploys.

const PROVIDER_BASE_URLS = {
  wakatime: "https://wakatime.com/api/v1",
  hackatime: "https://hackatime.hackclub.com/api/v1",
};

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

// ── Unified tracker client (both providers are Wakatime-compatible) ─────────

class TimeTrackerClient {
  constructor(provider, apiKey) {
    this.base = PROVIDER_BASE_URLS[provider] ?? PROVIDER_BASE_URLS.wakatime;
    this.key = apiKey;
  }

  async testConnection() {
    try {
      const res = await this.get("/users/current");
      return res.ok;
    } catch {
      return false;
    }
  }

  async listProjects() {
    const res = await this.get("/users/current/projects");
    if (!res.ok) return [];
    const body = await res.json();
    return Array.isArray(body?.data) ? body.data : [];
  }

  async getAllTimeSeconds(projectName) {
    const url = `/users/current/all_time_since_today?project=${encodeURIComponent(projectName)}`;
    const res = await this.get(url);
    if (!res.ok) return null;
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
    const url = `/users/current/summaries?start=${isoDate(start)}&end=${isoDate(end)}`;
    let entries;
    try {
      const res = await this.get(url);
      if (!res.ok) return { daily: [], languages: [] };
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

  get(path) {
    return fetch(`${this.base}${path}`, {
      headers: {
        Authorization: `Basic ${Buffer.from(this.key).toString("base64")}`,
        "User-Agent": "skillhive-sync/1.0",
      },
    });
  }
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

// ── Sync orchestration ──────────────────────────────────────────────────────

async function syncConnection(conn) {
  try {
    const client = new TimeTrackerClient(conn.provider, conn.api_key);
    if (!(await client.testConnection())) throw new Error("api key rejected by tracker");

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

async function loadConnections(userId) {
  let query = supabaseAdmin
    .from("time_tracker_connections")
    .select("user_id, provider, api_key, last_sync_at")
    .eq("status", "active");
  if (userId) query = query.eq("user_id", userId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data ?? [];
}

async function syncAllConnections() {
  const connections = await loadConnections(null);
  const results = [];
  for (const conn of connections) {
    results.push(await syncConnection(conn));
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
    const connections = await loadConnections(user.id);
    if (connections.length === 0) {
      return res.status(200).json({ synced: 0, results: [] });
    }

    const results = [];
    for (const conn of connections) {
      if (!force && isDebounced(conn.last_sync_at)) {
        results.push({ user_id: conn.user_id, ok: false, skipped: true });
        continue;
      }
      results.push(await syncConnection(conn));
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

module.exports = { initTimeTrackerSync, handleManualSync };
