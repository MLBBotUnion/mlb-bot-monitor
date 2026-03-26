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

    // Step 1: get user ID
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

          // Step 2: get most recent tweet
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

// ─── Main ─────────────────────────────────────────────────────────────────────
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
        label:     check.label,
        checkedAt: new Date().toISOString(),
      };
      const icon = result.status === 'HEALTHY' ? '✅' : result.status === 'ERROR' ? '❌' : '⚠️';
      console.log(`  ${icon} ${check.label}: ${result.status} ${result.latency ? `(${result.latency}ms)` : ''}`);
    }

    // Twitter stats — each bot uses its own bearer token
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

  const output = { generatedAt: new Date().toISOString(), bots: results };
  const outPath = path.join(__dirname, '..', 'public', 'status.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\n✅ status.json written to ${outPath}`);
}

main().catch(err => {
  console.error('Monitor script failed:', err);
  process.exit(1);
});
