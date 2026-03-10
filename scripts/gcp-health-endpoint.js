/**
 * =====================================================================
 * ADD THIS TO EACH OF YOUR 3 GCP BOTS
 * =====================================================================
 * This exposes a /health endpoint on your Cloud Function / Cloud Run
 * service. GitHub Actions pings it every 5 minutes to confirm the
 * bot process is alive and its last run succeeded.
 *
 * SETUP:
 *   1. Copy this file into each bot's project folder
 *   2. In your bot's main entry point, register the /health route
 *      (examples below for Express and plain Cloud Functions)
 *   3. Deploy as normal — no extra GCP config needed
 *   4. Copy the deployed URL into GitHub Secrets:
 *        ACUNA_BOT_HEALTH_URL   = https://YOUR-REGION-PROJECT.cloudfunctions.net/acuna-bot/health
 *        DONTJINX_BOT_HEALTH_URL = https://...
 *        TRACKER_BOT_HEALTH_URL  = https://...
 * =====================================================================
 */

// ─── Shared state (in-memory, resets on cold start) ──────────────────────────
const healthState = {
  status:       'HEALTHY',   // 'HEALTHY' | 'WARNING' | 'ERROR'
  lastRunAt:    null,        // ISO string of last successful execution
  lastRunStatus:'UNKNOWN',   // 'OK' | 'ERROR'
  lastError:    null,        // Error message if last run failed
  tweetsPosted: 0,           // Lifetime tweet count this instance
  startedAt:    new Date().toISOString(),
};

/** Call this at the end of each successful bot execution */
function markSuccess(details = {}) {
  healthState.status       = 'HEALTHY';
  healthState.lastRunAt    = new Date().toISOString();
  healthState.lastRunStatus= 'OK';
  healthState.lastError    = null;
  if (details.tweeted) healthState.tweetsPosted++;
}

/** Call this when the bot catches an error */
function markError(err) {
  healthState.status        = 'ERROR';
  healthState.lastRunAt     = new Date().toISOString();
  healthState.lastRunStatus = 'ERROR';
  healthState.lastError     = err?.message || String(err);
}

// ─── Health handler ───────────────────────────────────────────────────────────
function healthHandler(req, res) {
  const minutesSinceRun = healthState.lastRunAt
    ? (Date.now() - new Date(healthState.lastRunAt)) / 60000
    : null;

  // Warn if last run was more than 15 minutes ago (should run every ~5 min)
  const stale = minutesSinceRun !== null && minutesSinceRun > 15;

  const payload = {
    status:          stale ? 'WARNING' : healthState.status,
    lastRunAt:       healthState.lastRunAt,
    lastRunStatus:   healthState.lastRunStatus,
    minutesSinceRun: minutesSinceRun ? Math.round(minutesSinceRun) : null,
    stale,
    tweetsPosted:    healthState.tweetsPosted,
    startedAt:       healthState.startedAt,
    uptime:          Math.round((Date.now() - new Date(healthState.startedAt)) / 1000) + 's',
    ...(healthState.lastError ? { lastError: healthState.lastError } : {}),
  };

  const httpStatus = healthState.status === 'ERROR' ? 503 : 200;
  res.status(httpStatus).json(payload);
}

// ─── Usage examples ───────────────────────────────────────────────────────────

/*
 * IF YOUR BOT USES EXPRESS:
 * ─────────────────────────
 * const express = require('express');
 * const app = express();
 * const { healthHandler, markSuccess, markError } = require('./health');
 *
 * app.get('/health', healthHandler);
 *
 * async function runBot() {
 *   try {
 *     // ... your bot logic ...
 *     markSuccess({ tweeted: true });
 *   } catch (err) {
 *     markError(err);
 *     throw err;
 *   }
 * }
 *
 *
 * IF YOUR BOT IS A PLAIN CLOUD FUNCTION (HTTP trigger):
 * ──────────────────────────────────────────────────────
 * exports.botHandler = async (req, res) => {
 *   if (req.path === '/health') return healthHandler(req, res);
 *
 *   try {
 *     // ... your bot logic ...
 *     markSuccess({ tweeted: false });
 *     res.send('OK');
 *   } catch (err) {
 *     markError(err);
 *     res.status(500).send(err.message);
 *   }
 * };
 */

module.exports = { healthHandler, markSuccess, markError };
