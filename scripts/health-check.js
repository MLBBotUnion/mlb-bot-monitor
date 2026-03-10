/**
 * MLB Bot Health Check Script
 * Runs in GitHub Actions every 5 minutes.
 * Pings each GCP bot's /health endpoint, checks MLB + Twitter APIs,
 * then writes results to public/status.json for the dashboard to read.
 */

const https = require('https');
const fs   = require('fs');
const path = require('path');

// ─── Bot definitions ─────────────────────────────────────────────────────────
// Health URL comes from GitHub Secrets (your GCP Cloud Function URL)
const BOTS = [
  {
    id:          'acuna-hr',
    name:        'Acuña HR Bot',
    emoji:       '💥',
    description: 'Tweets every Ronald Acuña home run with Statcast GIF',
    gcpService:  'Cloud Run',
    healthUrl:   process.env.ACUNA_BOT_HEALTH_URL,
    checks: [
      { id: 'mlb_api',      label: 'MLB Stats API',   url: 'https://statsapi.mlb.com/api/v1/sports' },
      { id: 'statcast',     label: 'Statcast',         url: 'https://baseballsavant.mlb.com' },
      { id: 'twitter_api',  label: 'X / Twitter API',  url: 'https://api.twitter.com/2/tweets' },
      { id: 'gcp_function', label: 'GCP Cloud Run',    url: process.env.ACUNA_BOT_HEALTH_URL },
    ],
  },
  {
    id:          'dont-jinx-it',
    name:        "Don't Jinx It Bot",
    emoji:       '🤫',
    description: 'Tracks perfect games, no-hitters & rare MLB events',
    gcpService:  'Cloud Functions + Pub/Sub',
    healthUrl:   process.env.DONTJINX_BOT_HEALTH_URL,
    checks: [
      { id: 'mlb_live',     label: 'MLB Live Feed',    url: 'https://statsapi.mlb.com/api/v1/schedule?sportId=1' },
      { id: 'twitter_api',  label: 'X / Twitter API',  url: 'https://api.twitter.com/2/tweets' },
      { id: 'gcp_pubsub',   label: 'GCP Pub/Sub',      url: process.env.DONTJINX_BOT_HEALTH_URL },
      { id: 'gcp_function', label: 'GCP Function',     url: process.env.DONTJINX_BOT_HEALTH_URL },
    ],
  },
  {
    id:          '4040-tracker',
    name:        '40-40 Tracker Bot',
    emoji:       '⚡',
    description: 'Monitors MLB players chasing 40 HR / 40 SB milestone',
    gcpService:  'Cloud Scheduler + Cloud Run',
    healthUrl:   process.env.TRACKER_BOT_HEALTH_URL,
    checks: [
      { id: 'mlb_api',      label: 'MLB Stats API',    url: 'https://statsapi.mlb.com/api/v1/sports' },
      { id: 'twitter_api',  label: 'X / Twitter API',  url: 'https://api.twitter.com/2/tweets' },
      { id: 'gcp_scheduler',label: 'Cloud Scheduler',  url: process.env.TRACKER_BOT_HEALTH_URL },
      { id: 'gcp_function', label: 'GCP Cloud Run',    url: process.env.TRACKER_BOT_HEALTH_URL },
    ],
  },
];

// ─── HTTP helper ─────────────────────────────────────────────────────────────
function ping(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (!url) {
      resolve({ status: 'UNKNOWN', latency: null, error: 'URL not configured' });
      return;
    }
    const start = Date.now();
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      const latency = Date.now() - start;
      // 200-399 = healthy, 401/403 = API is up but auth needed (still healthy infra)
      const ok = res.statusCode < 500;
      resolve({
        status:  ok ? 'HEALTHY' : 'ERROR',
        latency,
        httpCode: res.statusCode,
      });
      res.resume(); // Drain response
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 'ERROR', latency: timeoutMs, error: 'Timeout' });
    });
    req.on('error', (err) => {
      resolve({ status: 'ERROR', latency: Date.now() - start, error: err.message });
    });
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n⚾ MLB Bot Monitor — ${new Date().toISOString()}\n`);

  const results = {};

  for (const bot of BOTS) {
    console.log(`Checking ${bot.name}…`);
    const checkResults = {};

    for (const check of bot.checks) {
      const result = await ping(check.url);
      checkResults[check.id] = {
        ...result,
        label:      check.label,
        checkedAt:  new Date().toISOString(),
      };
      const icon = result.status === 'HEALTHY' ? '✅' : result.status === 'ERROR' ? '❌' : '⚠️';
      console.log(`  ${icon} ${check.label}: ${result.status} ${result.latency ? `(${result.latency}ms)` : ''}`);
    }

    // Overall bot status = worst of its checks
    const statuses = Object.values(checkResults).map(c => c.status);
    const overall  = statuses.includes('ERROR')   ? 'ERROR'
                   : statuses.includes('UNKNOWN')  ? 'WARNING'
                   : 'HEALTHY';

    results[bot.id] = {
      id:          bot.id,
      name:        bot.name,
      emoji:       bot.emoji,
      description: bot.description,
      gcpService:  bot.gcpService,
      overall,
      checks:      checkResults,
      scannedAt:   new Date().toISOString(),
    };
  }

  // ─── Write status.json ──────────────────────────────────────────────────
  const output = {
    generatedAt: new Date().toISOString(),
    bots: results,
  };

  const outPath = path.join(__dirname, '..', 'public', 'status.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\n✅ status.json written to ${outPath}`);
}

main().catch(err => {
  console.error('Monitor script failed:', err);
  process.exit(1);
});
