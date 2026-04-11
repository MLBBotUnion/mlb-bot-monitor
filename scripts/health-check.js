/**
 * MLB Bot Health Check Script
 * Runs in GitHub Actions every 5 minutes.
 * Pings each GCP bot's /health endpoint, checks MLB + Twitter APIs,
 * then writes results to public/status.json for the dashboard to read.
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ─── Bot definitions ──────────────────────────────────────────────────────────
const BOTS = [
  {
    id:            'acuna-hr',
    name:          'Acuña HR Bot',
    emoji:         '💥',
    description:   'Tweets every Ronald Acuña home run with Statcast GIF',
    gcpService:    'Cloud Run',
    twitterHandle: 'acuna4040',
    bearerToken:   process.env.ACUNA_BEARER_TOKEN,
    healthUrl:     process.env.ACUNA_BOT_HEALTH_URL,
    checks: [
      { id: 'mlb_api',      label: 'MLB Stats API',  url: 'https://statsapi.mlb.com/api/v1/sports' },
      { id: 'statcast',     label: 'Statcast',        url: 'https://baseballsavant.mlb.com' },
      { id: 'twitter_api',  label: 'X / Twitter API', url: 'https://api.twitter.com/2/tweets' },
      { id: 'gcp_function', label: 'GCP Cloud Run',   url: process.env.ACUNA_BOT_HEALTH_URL },
    ],
  },
  {
    id:            'dont-jinx-it',
    name:          "Don't Jinx It Bot",
    emoji:         '🤫',
    description:   'Tracks perfect games, no-hitters & rare MLB events',
    gcpService:    'Cloud Functions + Pub/Sub',
    twitterHandle: 'dontjinxitmlb',
    bearerToken:   process.env.DONTJINX_BEARER_TOKEN,
    healthUrl:     process.env.DONTJINX_BOT_HEALTH_URL,
    checks: [
      { id: 'mlb_live',     label: 'MLB Live Feed',   url: 'https://statsapi.mlb.com/api/v1/schedule?sportId=1' },
      { id: 'twitter_api',  label: 'X / Twitter API', url: 'https://api.twitter.com/2/tweets' },
      { id: 'gcp_pubsub',   label: 'GCP Pub/Sub',     url: process.env.DONTJINX_BOT_HEALTH_URL },
      { id: 'gcp_function', label: 'GCP Function',    url: process.env.DONTJINX_BOT_HEALTH_URL },
    ],
  },
  {
    id:            '4040-tracker',
    name:          '40-40 Tracker Bot',
    emoji:         '⚡',
    description:   'Monitors MLB players chasing 40 HR / 40 SB milestone',
    gcpService:    'Cloud Scheduler + Cloud Run',
    twitterHandle: '4040tracker',
    bearerToken:   process.env.TRACKER_BEARER_TOKEN,
    healthUrl:     process.env.TRACKER_BOT_HEALTH_URL,
    checks: [
      { id: 'mlb_api',       label: 'MLB Stats API',  url: 'https://statsapi.mlb.com/api/v1/sports' },
      { id: 'twitter_api',   label: 'X / Twitter API', url: 'https://api.twitter.com/2/tweets' },
      { id: 'gcp_scheduler', label: 'Cloud Scheduler', url: process.env.TRACKER_BOT_HEALTH_URL },
      { id: 'gcp_function',  label: 'GCP Cloud Run',   url: process.env.TRACKER_BOT_HEALTH_URL },
    ],
  },
];

// ─── HTTP helper ──────────────────────────────────────────────────────────────
function ping(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (!url) {
      resolve({ status: 'UNKNOWN', latency: null, error: 'URL not configured' });
      return;
    }
    const start = Date.now();
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      const latency = Date.now() - start;
      const ok = res.statusCode < 500;
      resolve({ status: ok ? 'HEALTHY' : 'ERROR', latency, httpCode: res.statusCode });
      res.resume();
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 'ERROR', latency: timeoutMs, error: 'Timeout' }); });
    req.on('error',   (err) => { resolve({ status: 'ERROR', latency: Date.now() - start, error: err.message }); });
  });
}

// ─── Twitter stats helper ─────────────────────────────────────────────────────
function fetchTwitterStats(handle, bearerToken) {
  return new Promise((resolve) => {
    if (!bearerToken) {
      resolve({ error: 'Bearer token not configured' });
      return;
    }
    const options = {
      hostname: 'api.twitter.com',
      path:     `/2/users/by/username/${handle}?user.fields=public_metrics`,
      method:   'GET',
      headers:  { Authorization: `Bearer ${bearerToken}` },
      timeout:  8000,
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json.errors || !json.data) {
            resolve({ error: json.errors?.[0]?.detail || 'Unknown Twitter API error' });
            return;
          }
          const m = json.data.public_metrics;
          resolve({
            followers:  m.followers_count,
            following:  m.following_count,
            tweetCount: m.tweet_count,
          });
        } catch (e) {
          resolve({ error: `Parse error: ${e.message}` });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ error: 'Timeout' }); });
    req.on('error',   (e) => resolve({ error: e.message }));
    req.end();
  });
}

// ─── Fetch last tweet ─────────────────────────────────────────────────────────
function fetchLastTweet(handle, bearerToken) {
  return new Promise((resolve) => {
    if (!bearerToken) { resolve(null); return; }
    const idOptions = {
      hostname: 'api.twitter.com',
      path:     `/2/users/by/username/${handle}?user.fields=id`,
      method:   'GET',
      headers:  { Authorization: `Bearer ${bearerToken}` },
      timeout:  8000,
    };
    const idReq = https.request(idOptions, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          const userId = json.data?.id;
          if (!userId) { resolve(null); return; }
          const tweetOptions = {
            hostname: 'api.twitter.com',
            path:     `/2/users/${userId}/tweets?max_results=5&tweet.fields=created_at,text,public_metrics&exclude=retweets,replies`,
            method:   'GET',
            headers:  { Authorization: `Bearer ${bearerToken}` },
            timeout:  8000,
          };
          const tweetReq = https.request(tweetOptions, (tRes) => {
            let tBody = '';
            tRes.on('data', chunk => tBody += chunk);
            tRes.on('end', () => {
              try {
                const tJson = JSON.parse(tBody);
                const tweet = tJson.data?.[0];
                if (!tweet) { resolve(null); return; }
                resolve({
                  id:        tweet.id,
                  text:      tweet.text,
                  createdAt: tweet.created_at,
                  likes:     tweet.public_metrics?.like_count    ?? 0,
                  retweets:  tweet.public_metrics?.retweet_count ?? 0,
                  replies:   tweet.public_metrics?.reply_count   ?? 0,
                  url:       `https://twitter.com/${handle}/status/${tweet.id}`,
                });
              } catch (e) { resolve(null); }
            });
          });
          tweetReq.on('error', () => resolve(null));
          tweetReq.end();
        } catch (e) { resolve(null); }
      });
    });
    idReq.on('error', () => resolve(null));
    idReq.end();
  });
}

// ─── Follower history helpers ─────────────────────────────────────────────────
const HISTORY_PATH = path.join(__dirname, '..', 'public', 'twitter-history.json');
const MAX_DAYS     = 10; // keep 10 days of snapshots

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_PATH)) {
      return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    }
  } catch (e) {
    console.log('  ⚠️  Could not read twitter-history.json, starting fresh');
  }
  return { snapshots: [] };
}

function saveHistory(history) {
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
}

function updateHistory(history, botFollowers) {
  const todayStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // Check if we already have a snapshot for today
  const existingToday = history.snapshots.find(s => s.date === todayStr);
  if (existingToday) {
    // Update today's snapshot with latest counts
    existingToday.followers = botFollowers;
    console.log(`  📅 Updated today's snapshot (${todayStr})`);
  } else {
    // Add new daily snapshot
    history.snapshots.push({ date: todayStr, followers: botFollowers });
    console.log(`  📅 Added new daily snapshot (${todayStr})`);
  }

  // Trim to MAX_DAYS
  history.snapshots.sort((a, b) => a.date.localeCompare(b.date));
  if (history.snapshots.length > MAX_DAYS) {
    history.snapshots = history.snapshots.slice(-MAX_DAYS);
  }

  return history;
}

function get7DayDelta(history, botId) {
  const snapshots = history.snapshots;
  if (snapshots.length < 2) return null;

  const today     = snapshots[snapshots.length - 1];
  const todayVal  = today.followers?.[botId];
  if (todayVal == null) return null;

  // Find snapshot closest to 7 days ago
  const todayDate   = new Date(today.date);
  const targetDate  = new Date(todayDate);
  targetDate.setDate(targetDate.getDate() - 7);

  // Find the snapshot nearest to 7 days ago
  let best = null;
  let bestDiff = Infinity;
  for (const snap of snapshots.slice(0, -1)) {
    const diff = Math.abs(new Date(snap.date) - targetDate);
    if (diff < bestDiff && snap.followers?.[botId] != null) {
      bestDiff = diff;
      best = snap;
    }
  }

  if (!best) return null;
  return todayVal - best.followers[botId];
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n⚾ MLB Bot Monitor — ${new Date().toISOString()}\n`);

  const results      = {};
  const botFollowers = {}; // { botId: followerCount } for history snapshot

  for (const bot of BOTS) {
    console.log(`Checking ${bot.name}…`);
    const checkResults = {};

    for (const check of bot.checks) {
      const result = await ping(check.url);
      checkResults[check.id] = {
        ...result,
        label:     check.label,
        checkedAt: new Date().toISOString(),
      };
      const icon = result.status === 'HEALTHY' ? '✅' : result.status === 'ERROR' ? '❌' : '⚠️';
      console.log(`  ${icon} ${check.label}: ${result.status} ${result.latency ? `(${result.latency}ms)` : ''}`);
    }

    // Twitter stats
    let twitter = null;
    if (bot.twitterHandle && bot.bearerToken) {
      console.log(`  🐦 Fetching Twitter stats for @${bot.twitterHandle}…`);
      const [stats, lastTweet] = await Promise.all([
        fetchTwitterStats(bot.twitterHandle, bot.bearerToken),
        fetchLastTweet(bot.twitterHandle, bot.bearerToken),
      ]);
      twitter = { handle: bot.twitterHandle, ...stats, lastTweet };
      if (stats.error) {
        console.log(`  ⚠️  Twitter stats error: ${stats.error}`);
      } else {
        console.log(`  ✅ Followers: ${stats.followers?.toLocaleString()} | Tweets: ${stats.tweetCount?.toLocaleString()}`);
        botFollowers[bot.id] = stats.followers;
      }
    } else {
      console.log(`  ⚠️  Skipping Twitter stats — bearer token not configured`);
      twitter = { handle: bot.twitterHandle, error: 'Bearer token not configured' };
    }

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
      twitter,
      scannedAt:   new Date().toISOString(),
    };
  }

  // ─── Update follower history ───────────────────────────────────────────────
  console.log('\n📊 Updating follower history…');
  const history = loadHistory();
  updateHistory(history, botFollowers);

  // Attach 7-day delta to each bot's twitter data
  for (const bot of BOTS) {
    const delta = get7DayDelta(history, bot.id);
    if (results[bot.id]?.twitter && delta !== null) {
      results[bot.id].twitter.followerDelta7d = delta;
      console.log(`  📈 ${bot.name} 7d delta: ${delta >= 0 ? '+' : ''}${delta}`);
    }
  }

  saveHistory(history);
  console.log('✅ twitter-history.json updated');

  // ─── Write status.json ────────────────────────────────────────────────────
  const output = { generatedAt: new Date().toISOString(), bots: results };
  const outPath = path.join(__dirname, '..', 'public', 'status.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`✅ status.json written to ${outPath}\n`);
}

main().catch(err => {
  console.error('Monitor script failed:', err);
  process.exit(1);
});
