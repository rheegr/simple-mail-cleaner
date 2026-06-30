# Simple Mail Cleaner

Gmail inbox cleanup tool. Select a sender and delete all their emails in one click — with optional unsubscribe.

## Features

- Sender list grouped by email count
- **Unsubscribe & Clean**: one-click RFC 8058 unsubscribe + bulk delete
- **Clean Out**: bulk delete without unsubscribe
- Period filter: All time / More than 1m / 3m / 1yr
- Chrome extension (MV3) that overlays Gmail directly

## Structure

```
app/          Next.js web app (sender list + API routes)
extension/    Chrome MV3 extension (Gmail overlay)
```

## Setup

1. Copy `.env.example` to `.env.local` and fill in Google OAuth credentials
2. `npm install && npm run dev`

See `extension/README.md` for Chrome extension setup.
