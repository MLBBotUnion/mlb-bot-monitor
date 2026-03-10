# ⚾ MLB Bot Monitor

A free, self-hosted monitoring dashboard for your 3 GCP-hosted MLB Twitter bots.

**Stack:** GitHub Actions (cron pinger) · GitHub Pages (dashboard) · Claude AI (diagnosis)  
**Cost:** $0 — runs entirely on free tiers

---

## How it works

```
Every 5 min:
  GitHub Actions → pings each GCP bot's /health endpoint
                 → checks MLB Stats API + X/Twitter API reachability
                 → writes public/status.json
                 → commits back to repo

Dashboard (GitHub Pages):
  React app → fetches status.json every 60s
            → shows live health per bot + per check
            → "Run Diagnosis" → calls Claude AI for root cause analysis
```

---

## Setup (one-time, ~15 minutes)

### 1. Create the GitHub repo

```bash
git init mlb-bot-monitor
cd mlb-bot-monitor
# copy all these files in
git add .
git commit -m "initial"
git remote add origin https://github.com/YOUR_USERNAME/mlb-bot-monitor.git
git push -u origin main
```

### 2. Add GitHub Secrets

Go to: **GitHub repo → Settings → Secrets and variables → Actions → New repository secret**

| Secret name | Value |
|---|---|
| `ACUNA_BOT_HEALTH_URL` | `https://YOUR-REGION-PROJECT.cloudfunctions.net/acuna-bot/health` |
| `DONTJINX_BOT_HEALTH_URL` | `https://YOUR-REGION-PROJECT.cloudfunctions.net/dontjinx-bot/health` |
| `TRACKER_BOT_HEALTH_URL` | `https://YOUR-REGION-PROJECT.cloudfunctions.net/tracker-bot/health` |

> 💡 Get each URL from: **GCP Console → Cloud Functions → [function name] → Trigger tab → URL**  
> Then append `/health` to it.

### 3. Add /health endpoint to each GCP bot

Copy `scripts/gcp-health-endpoint.js` into each of your 3 bot projects.  
Then wire it up (see examples inside the file — takes ~5 lines).  
Redeploy each bot to GCP.

### 4. Enable GitHub Pages

Go to: **GitHub repo → Settings → Pages**  
- Source: **GitHub Actions**  
- Save

### 5. That's it

- Push to `main` → GitHub Actions builds and deploys the dashboard automatically
- Every 5 minutes → Actions pings your bots and updates `status.json`
- Visit `https://YOUR_USERNAME.github.io/mlb-bot-monitor` to see the dashboard

---

## Local development

```bash
npm install
npm run dev
# Dashboard runs at http://localhost:5173
# Note: status.json loads from /public/status.json in dev
```

---

## Files

```
mlb-bot-monitor/
├── .github/
│   └── workflows/
│       ├── monitor.yml        ← Runs every 5 min, pings bots, writes status.json
│       └── deploy.yml         ← Builds + deploys React app to GitHub Pages on push
├── scripts/
│   ├── health-check.js        ← The actual monitoring agent logic
│   └── gcp-health-endpoint.js ← Add this to each of your 3 GCP bots
├── src/
│   ├── main.jsx
│   └── App.jsx                ← Dashboard UI + Claude AI diagnosis
├── public/
│   └── status.json            ← Written by GitHub Actions, read by dashboard
├── index.html
├── vite.config.js
└── package.json
```

---

## Customizing check intervals

Edit `.github/workflows/monitor.yml`:
```yaml
schedule:
  - cron: '*/5 * * * *'   # every 5 min (GitHub Actions minimum)
  - cron: '*/10 * * * *'  # every 10 min
  - cron: '0 * * * *'     # every hour
```

> ⚠️ GitHub Actions free tier = 2,000 minutes/month.  
> At 5-min intervals = ~288 runs/day × ~0.5 min each = ~144 min/day = well within free limits.
