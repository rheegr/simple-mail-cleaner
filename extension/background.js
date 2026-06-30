// Simple Mail Cleaner background service worker.
// Handles OAuth (chrome.identity) and all Gmail API calls. The content script
// (running inside Gmail) cannot call the API directly, so it messages us here.

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

// older_than query fragment per UI period option.
const PERIOD_QUERY = {
  "1m": "older_than:1m",
  "3m": "older_than:3m",
  "1y": "older_than:1y",
  all: "",
};

function getToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(chrome.runtime.lastError?.message || "No token"));
      } else {
        resolve(token);
      }
    });
  });
}

// Drop a cached token (e.g. after a 401) so the next getToken re-fetches.
function removeToken(token) {
  return new Promise((resolve) => {
    chrome.identity.removeCachedAuthToken({ token }, () => resolve());
  });
}

// Fetch against the Gmail API with one automatic retry after a token refresh on 401.
async function gapi(path, init = {}, _retried = false) {
  const token = await getToken(!_retried ? true : true);
  const res = await fetch(`${GMAIL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });

  if (res.status === 401 && !_retried) {
    await removeToken(token);
    return gapi(path, init, true);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gmail ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.status === 204 ? null : res.json();
}

// List every message id matching a query (paginated).
async function listAllIds(q) {
  const ids = [];
  let pageToken;
  do {
    const params = new URLSearchParams({ q, maxResults: "500" });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await gapi(`/messages?${params}`);
    for (const m of data.messages ?? []) ids.push(m.id);
    pageToken = data.nextPageToken;
  } while (pageToken);
  return ids;
}

async function countBySender(senderEmail) {
  // Gmail's resultSizeEstimate is unreliable — it returns a near-constant rough
  // number regardless of the query, so every sender looked identical. Count the
  // real message ids by paging instead. Cap to keep huge senders responsive.
  const CAP = 5000;
  let count = 0;
  let pageToken;
  let capped = false;
  do {
    const params = new URLSearchParams({
      q: `from:${senderEmail}`,
      maxResults: "500",
      fields: "messages/id,nextPageToken",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await gapi(`/messages?${params}`);
    count += (data.messages || []).length;
    pageToken = data.nextPageToken;
    if (count >= CAP && pageToken) {
      capped = true;
      break;
    }
  } while (pageToken);
  return { count, capped };
}

async function deleteBySender({ senderEmail, period, permanent }) {
  const periodQuery = PERIOD_QUERY[period] ?? "";
  const q = [`from:${senderEmail}`, periodQuery].filter(Boolean).join(" ");
  const ids = await listAllIds(q);
  if (ids.length === 0) return { deleted: 0 };

  const BATCH = 1000;
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    if (permanent) {
      await gapi(`/messages/batchDelete`, {
        method: "POST",
        body: JSON.stringify({ ids: chunk }),
      });
    } else {
      await gapi(`/messages/batchModify`, {
        method: "POST",
        body: JSON.stringify({ ids: chunk, addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] }),
      });
    }
  }
  return { deleted: ids.length };
}

// base64url-encode a string for the Gmail messages.send `raw` field.
function base64url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Send an unsubscribe email from the user's own Gmail to a List-Unsubscribe mailto.
async function sendUnsubscribeMail(mailto) {
  const u = new URL(mailto); // mailto:addr?subject=...&body=...
  const to = decodeURIComponent(u.pathname);
  if (!to) return false;
  const subject = u.searchParams.get("subject") || "unsubscribe";
  const body = u.searchParams.get("body") || "unsubscribe";
  const mime = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    body,
  ].join("\r\n");
  await gapi(`/messages/send`, { method: "POST", body: JSON.stringify({ raw: base64url(mime) }) });
  return true;
}

// Auto-clicker injected into a known provider's unsubscribe page. Best-effort:
// finds the most specific "unsubscribe / confirm" control and clicks it.
function autoClickUnsub() {
  const patterns = [
    /unsubscribe from all/i,
    /opt out of all/i,
    /confirm.*unsubscribe/i,
    /unsubscribe.*all/i,
    /^\s*unsubscribe\s*$/i,
    /수신\s*거부/,
    /구독\s*취소/,
  ];
  const clickables = [
    ...document.querySelectorAll('button, input[type="submit"], input[type="button"], a, [role="button"]'),
  ];
  const text = (el) => (el.innerText || el.value || el.getAttribute("aria-label") || "").trim();
  for (const p of patterns) {
    const el = clickables.find((e) => p.test(text(e)));
    if (el) {
      el.click();
      return text(el);
    }
  }
  return null;
}

const KNOWN_UNSUB_HOST = /(?:^|\.)(?:hubspotemail\.net|list-manage\.com|substack\.com|mailchimp\.com)$/i;

// Open an unsubscribe page in a background tab; auto-click it for known providers.
async function openUnsubPage(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  let known = false;
  try {
    known = KNOWN_UNSUB_HOST.test(new URL(url).hostname);
  } catch {}
  if (!known) return { method: "page-manual", url };

  await new Promise((resolve) => {
    const onDone = (tabId, info) => {
      if (tabId === tab.id && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(onDone);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(onDone);
    // safety timeout so we never hang
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onDone);
      resolve();
    }, 8000);
  });

  try {
    const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: autoClickUnsub });
    const clicked = results?.[0]?.result;
    // Give the page a moment to process the click, then close.
    if (clicked) setTimeout(() => chrome.tabs.remove(tab.id).catch(() => {}), 1200);
    return { method: "page-auto", url };
  } catch (e) {
    return { method: "page-manual", url, error: e.message };
  }
}

async function unsubscribeBySender({ senderEmail }) {
  // Check up to 5 recent messages — some senders omit the header on newer emails.
  const params = new URLSearchParams({ q: `from:${senderEmail}`, maxResults: "5" });
  const list = await gapi(`/messages?${params}`);
  const msgIds = (list.messages ?? []).map((m) => m.id);
  if (!msgIds.length) return { method: "none", reason: "No messages found" };

  let raw = "", isOneClick = false;
  for (const msgId of msgIds) {
    const msg = await gapi(
      `/messages/${msgId}?format=METADATA&metadataHeaders=List-Unsubscribe&metadataHeaders=List-Unsubscribe-Post`
    );
    const headers = msg.payload?.headers ?? [];
    const candidate = headers.find((h) => h.name === "List-Unsubscribe")?.value ?? "";
    if (candidate) {
      raw = candidate;
      isOneClick = headers.some((h) => h.name === "List-Unsubscribe-Post");
      break;
    }
  }

  const urls = [...raw.matchAll(/<(https?:\/\/[^>]+)>/g)].map((m) => m[1]);
  const mailtos = [...raw.matchAll(/<(mailto:[^>]+)>/g)].map((m) => m[1]);

  if (urls.length === 0 && mailtos.length === 0) {
    return { method: "none", reason: "No unsubscribe link" };
  }

  // 1) RFC 8058 one-click — fully automatic, no page.
  if (isOneClick && urls.length > 0) {
    try {
      const r = await fetch(urls[0], {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      });
      if (r.ok) return { method: "one-click", unsubscribed: true };
    } catch {
      // fall through
    }
  }

  // 2) mailto — send the unsubscribe email from the user's Gmail.
  if (mailtos.length > 0) {
    try {
      await sendUnsubscribeMail(mailtos[0]);
      return { method: "mailto", unsubscribed: true };
    } catch {
      // fall through to page
    }
  }

  // 3) URL only.
  if (urls.length > 0) {
    let host = "";
    try {
      host = new URL(urls[0]).hostname;
    } catch {}

    // Google Groups = leaving a (often internal) group. Never auto-leave;
    // just open the page so the user decides.
    if (/(?:^|\.)groups\.google\.com$/i.test(host)) {
      await chrome.tabs.create({ url: urls[0], active: false });
      return { method: "page-group", unsubscribed: false, url: urls[0] };
    }

    // Otherwise open the page; auto-click for known providers.
    const res = await openUnsubPage(urls[0]);
    return { unsubscribed: res.method === "page-auto", ...res };
  }

  return { method: "none", reason: "No usable unsubscribe method" };
}


async function scanSenders() {
  const FETCH_COUNT = 300;
  const CHUNK = 20;

  // Exclude sender's own domain (colleagues)
  let myDomain = null;
  try {
    const profile = await gapi('/profile');
    myDomain = profile.emailAddress?.split('@')[1]?.toLowerCase() ?? null;
  } catch(_) {}

  // Collect message IDs
  const ids = [];
  let pageToken;
  do {
    const params = new URLSearchParams({ maxResults: "100", fields: "messages/id,nextPageToken" });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await gapi(`/messages?${params}`);
    for (const m of data.messages ?? []) ids.push(m.id);
    pageToken = data.nextPageToken;
  } while (pageToken && ids.length < FETCH_COUNT);

  // Gmail auto-category labels — primary spam signal
  const CATEGORY_LABELS = new Set([
    "CATEGORY_PROMOTIONS", "CATEGORY_UPDATES",
    "CATEGORY_FORUMS", "CATEGORY_SOCIAL"
  ]);

  const senderMap = new Map();

  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const results = await Promise.all(chunk.map(id =>
      gapi(`/messages/${id}?format=METADATA&metadataHeaders=From&metadataHeaders=List-Unsubscribe&fields=id,labelIds,payload/headers`)
        .catch(() => null)
    ));

    for (const msg of results) {
      if (!msg) continue;
      const headers = msg.payload?.headers ?? [];
      const fromHeader = headers.find(h => h.name === "From")?.value ?? "";
      const hasUnsub = headers.some(h => h.name === "List-Unsubscribe" && h.value);
      const labels = msg.labelIds ?? [];
      const isUnread = labels.includes("UNREAD");
      const isCategory = labels.some(l => CATEGORY_LABELS.has(l));
      const isPromo = labels.includes("CATEGORY_PROMOTIONS");

      const m = fromHeader.match(/^(.*?)\s*<([^>]+)>$/) || fromHeader.match(/^([^<]+)$/);
      const email = (m?.[2] ?? fromHeader).toLowerCase().trim();
      const name = (m?.[1] ?? email).trim().replace(/^"|"$/g, "") || email;
      if (!email || !email.includes("@")) continue;

      // Skip own domain (colleagues)
      const senderDomain = email.split('@')[1]?.toLowerCase();
      if (myDomain && senderDomain === myDomain) continue;

      if (!senderMap.has(email)) {
        senderMap.set(email, {
          email, name, total: 0, unread: 0,
          categoryCount: 0, hasUnsub: false, isPromo: false
        });
      }
      const s = senderMap.get(email);
      s.total++;
      if (isUnread) s.unread++;
      if (isCategory) s.categoryCount++;
      if (hasUnsub) s.hasUnsub = true;
      if (isPromo) s.isPromo = true;
    }
  }

  // Score — category ratio is the primary signal
  const scored = [];
  for (const s of senderMap.values()) {
    if (s.total < 2) continue;
    const unreadRatio = s.unread / s.total;
    const categoryRatio = s.categoryCount / s.total;
    let score = 0;
    score += categoryRatio * 50;              // 0-50: Gmail auto-filed as promo/update/forum/social
    if (s.hasUnsub) score += 30;              // newsletter/marketing header
    score += unreadRatio * 20;                // 0-20: never opened (secondary signal)
    score += Math.min(s.total / 50, 1) * 10; // volume bonus (max 10)
    scored.push({
      ...s,
      unreadRatio: Math.round(unreadRatio * 100) / 100,
      categoryRatio: Math.round(categoryRatio * 100) / 100,
      score: Math.round(score)
    });
  }

  // Filter: must have meaningful spam signals
  return scored
    .filter(s => s.score >= 35 || (s.hasUnsub && s.total >= 5))
    .sort((a, b) => b.score - a.score || b.total - a.total)
    .slice(0, 60);
}

async function senderPreview({ senderEmail }) {
  const q = `from:${senderEmail}`;
  const data = await gapi(`/messages?${new URLSearchParams({ q, maxResults: "5", fields: "messages/id" })}`);
  const ids = (data.messages ?? []).map(m => m.id).slice(0, 5);
  const msgs = await Promise.all(ids.map(id =>
    gapi(`/messages/${id}?format=METADATA&metadataHeaders=Subject&fields=snippet,payload/headers`)
      .catch(() => null)
  ));
  return msgs.filter(Boolean).map(m => ({
    subject: m.payload?.headers?.find(h => h.name === "Subject")?.value ?? "(no subject)",
    snippet: m.snippet ?? ""
  }));
}


const HANDLERS = {
  ping: async () => ({ ok: true }),
  auth: async () => {
    await getToken(true);
    return { ok: true };
  },
  count: (p) => countBySender(p.senderEmail),
  delete: (p) => deleteBySender(p),
  unsubscribe: (p) => unsubscribeBySender(p),
  scanSenders: () => scanSenders(),
  senderPreview: (p) => senderPreview(p),
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = HANDLERS[msg?.type];
  if (!handler) {
    sendResponse({ error: `Unknown action: ${msg?.type}` });
    return false;
  }
  Promise.resolve(handler(msg.payload || {}))
    .then((data) => sendResponse({ data }))
    .catch((err) => sendResponse({ error: err.message || String(err) }));
  return true; // keep the message channel open for the async response
});
