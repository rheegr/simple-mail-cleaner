# Simple Mail Cleaner

A Chrome extension for Gmail that lets you unsubscribe and bulk-delete by sender in one click — not just the email you selected, but every email from that sender.

**Gmail only.** Works exclusively on `mail.google.com` via the Gmail API.

## What it does

- Select one or more emails in Gmail → an action bar appears at the bottom
- **Unsubscribe & Clean** — attempts to unsubscribe automatically, then moves all emails from that sender to Trash
- **Clean Out** — moves all emails from that sender to Trash (with optional permanent delete)
- Choose a time range: all time, older than 1 year, 3 months, or 1 month
- **Spam Radar** — a collapsible panel that scans your inbox and ranks senders by spam score (promo labels, unread ratio, newsletter headers, volume)

## Unsubscribe priority

1. RFC 8058 one-click POST — fully automatic, no page opened
2. `mailto:` — sends an unsubscribe email from your Gmail
3. Known providers (HubSpot, Mailchimp, Substack) — opens the page and auto-clicks the unsubscribe button
4. Google Groups — opens the page for manual review (to avoid accidentally leaving internal groups)
5. Everything else — opens the page for manual action

## Setup (self-hosted)

This extension uses the Gmail API via Chrome's `chrome.identity`. To run it yourself:

1. Create a project in [Google Cloud Console](https://console.cloud.google.com/)
2. Enable the **Gmail API**
3. Create an **OAuth 2.0 Client ID** of type *Chrome Extension*
4. Copy the client ID into `manifest.json` under `oauth2.client_id`
5. Open `chrome://extensions` in Chrome
6. Enable **Developer mode** (top right)
7. Click **Load unpacked** and select this folder
8. Open Gmail, select some emails, and the action bar will appear

## Files

| File | Purpose |
|---|---|
| `manifest.json` | MV3 manifest — permissions, OAuth config, content script declaration |
| `background.js` | Service worker — handles OAuth tokens and all Gmail API calls |
| `content.js` | Content script — injected into Gmail, handles UI (action bar, modal, toasts, Spam Radar) |
| `content.css` | Styles for injected UI (`smc-` prefix throughout) |

## Notes

- Actions apply to the **entire sender**, not just the selected messages
- Gmail's internal DOM (`tr.zA`, `span[email]`) is relied on for selection detection — may need updating if Gmail changes its markup
