# SIGINT Ticker — Vercel Deployment

This folder deploys the public intelligence ticker to Vercel.

## Setup

1. Edit `ticker.html` and set your server URL at the top of the script:
```js
window.API_BASE = 'https://your-tunnel.trycloudflare.com';
```

2. Deploy to Vercel:
```bash
npx vercel --prod
```

## Connecting to your local scraper

Your scraper backend must be reachable from the internet.
Use **Cloudflare Tunnel** (free, no account needed for temporary URLs):

```bash
# Install once
winget install cloudflare.cloudflared   # Windows
brew install cloudflare/cloudflare/cloudflared  # Mac

# Start a tunnel to your running scraper
cloudflared tunnel --url http://localhost:3001
```

Cloudflare will print a URL like:
  https://abc-def-ghi.trycloudflare.com

Paste that URL as window.API_BASE in ticker.html, redeploy, done.

## Admin UI access

The admin UI is at your tunnel URL: https://abc-def-ghi.trycloudflare.com
It's protected by login. Default credentials: admin / changeme
Set ADMIN_USER and ADMIN_PASS environment variables to change them.
