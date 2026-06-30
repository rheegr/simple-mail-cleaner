// Simple Mail Cleaner content script — runs inside Gmail.
// Watches the message list for selected rows, surfaces an action bar, and on
// confirmation tells the background worker to Unsubscribe & Clean / Clean Out
// the WHOLE sender of each selected email.

(() => {
  "use strict";

  const PERIODS = [
    { key: "all", label: "All time" },
    { key: "1y", label: "Older than 1 year" },
    { key: "3m", label: "Older than 3 months" },
    { key: "1m", label: "Older than 1 month" },
  ];

  // ---- messaging to background ----
  function send(type, payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, payload }, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!resp) return reject(new Error("No response from background"));
        if (resp.error) return reject(new Error(resp.error));
        resolve(resp.data);
      });
    });
  }

  // ---- read selected senders from the Gmail DOM ----
  // Gmail rows are <tr.zA>; a selected row carries class "x7" or an aria-checked
  // checkbox. The sender lives in a <span email="..." name="..."> inside the row.
  function getSelectedSenders() {
    const map = new Map(); // email -> { email, name, subject }
    const rows = document.querySelectorAll("tr.zA");
    for (const row of rows) {
      const checkbox = row.querySelector('[role="checkbox"]');
      const checked =
        row.classList.contains("x7") ||
        (checkbox && checkbox.getAttribute("aria-checked") === "true");
      if (!checked) continue;

      const span = row.querySelector("span[email]");
      const email = (span?.getAttribute("email") || "").toLowerCase().trim();
      if (!email) continue;
      const name = span?.getAttribute("name") || email;
      const subject = row.querySelector(".bog")?.textContent || "";
      if (!map.has(email)) map.set(email, { email, name, subject });
    }
    return [...map.values()];
  }

  // ---- UI: action bar ----
  let bar, barCount;
  function buildBar() {
    bar = document.createElement("div");
    bar.id = "smc-bar";
    bar.innerHTML = `
      <span id="smc-bar-count"></span>
      <button id="smc-unsub" class="smc-btn smc-btn-teal">Unsubscribe &amp; Clean</button>
      <button id="smc-del" class="smc-btn smc-btn-rose">Clean Out</button>
    `;
    document.body.appendChild(bar);
    barCount = bar.querySelector("#smc-bar-count");
    bar.querySelector("#smc-unsub").addEventListener("click", () => openModal("unsubscribe"));
    bar.querySelector("#smc-del").addEventListener("click", () => openModal("delete"));
  }

  let lastKey = "";
  function refreshBar() {
    const senders = getSelectedSenders();
    const key = senders.map((s) => s.email).sort().join(",");
    if (key === lastKey) return;
    lastKey = key;
    if (senders.length === 0) {
      bar.classList.remove("smc-show");
    } else {
      const n = senders.length;
      barCount.textContent = `${n} sender${n > 1 ? "s" : ""} selected`;
      bar.classList.add("smc-show");
    }
  }

  // ---- UI: confirm modal ----
  let modal;
  function openModal(mode) {
    const senders = getSelectedSenders();
    if (senders.length === 0) return;

    let period = "all";
    let permanent = false;

    if (modal) modal.remove();
    modal = document.createElement("div");
    modal.id = "smc-overlay";

    const isUnsub = mode === "unsubscribe";
    const title = isUnsub ? "Unsubscribe & Clean" : "Clean Out";

    modal.innerHTML = `
      <div id="smc-modal">
        <h2>${title}</h2>
        <p class="smc-sub">Acts on <b>every</b> email from ${senders.length} sender${
      senders.length > 1 ? "s" : ""
    } below, not only the messages you selected.</p>
        <div id="smc-senders"></div>
        <p class="smc-label">Delete which emails?</p>
        <div id="smc-periods"></div>
        ${
          isUnsub
            ? ""
            : `<label class="smc-perm"><input type="checkbox" id="smc-permanent"> Permanently delete (skip Trash, no recovery)</label>`
        }
        <div id="smc-actions">
          <button id="smc-cancel" class="smc-btn smc-btn-gray">Cancel</button>
          <button id="smc-confirm" class="smc-btn ${isUnsub ? "smc-btn-teal" : "smc-btn-rose"}">${
      isUnsub ? "Unsubscribe + Delete" : "Move to Trash"
    }</button>
        </div>
        <div id="smc-progress"></div>
      </div>`;
    document.body.appendChild(modal);

    // sender rows with lazy counts
    const list = modal.querySelector("#smc-senders");
    for (const s of senders) {
      const row = document.createElement("div");
      row.className = "smc-srow";
      row.innerHTML = `<span class="smc-sname">${escapeHtml(s.name)}</span>
        <span class="smc-semail">${escapeHtml(s.email)}</span>
        <span class="smc-scount" data-email="${escapeHtml(s.email)}">…</span>`;
      list.appendChild(row);
      send("count", { senderEmail: s.email })
        .then((c) => {
          const el = list.querySelector(`.smc-scount[data-email="${cssEscape(s.email)}"]`);
          if (el) el.textContent = c.capped ? `${c.count}+` : `${c.count}`;
        })
        .catch(() => {});
    }

    // period buttons
    const periodsEl = modal.querySelector("#smc-periods");
    PERIODS.forEach((p) => {
      const b = document.createElement("button");
      b.className = "smc-period" + (p.key === period ? " smc-period-on" : "");
      b.textContent = p.label;
      b.addEventListener("click", () => {
        period = p.key;
        periodsEl.querySelectorAll(".smc-period").forEach((x) => x.classList.remove("smc-period-on"));
        b.classList.add("smc-period-on");
        const permEl = modal.querySelector("#smc-confirm");
        if (!isUnsub) permEl.textContent = permanent ? "Permanently Delete" : "Move to Trash";
      });
      periodsEl.appendChild(b);
    });

    if (!isUnsub) {
      modal.querySelector("#smc-permanent").addEventListener("change", (e) => {
        permanent = e.target.checked;
        modal.querySelector("#smc-confirm").textContent = permanent
          ? "Permanently Delete"
          : "Move to Trash";
      });
    }

    modal.querySelector("#smc-cancel").addEventListener("click", () => closeModal());
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeModal();
    });
    modal.querySelector("#smc-confirm").addEventListener("click", () =>
      runAction({ mode, senders, getPeriod: () => period, getPermanent: () => permanent })
    );
  }

  function closeModal() {
    if (modal) modal.remove();
    modal = null;
  }

  async function runAction({ mode, senders, getPeriod, getPermanent }) {
    const period = getPeriod();
    const permanent = getPermanent();

    // The job targets whole senders (already captured), so the Gmail selection
    // is no longer needed. Close the modal and clear the selection immediately
    // so the user can keep working on other senders while this runs in the
    // background — no lingering checkboxes piling up into the next pick.
    closeModal();
    deselectAll();

    const label = senders.length === 1 ? senders[0].email : `${senders.length} senders`;
    const verbing = mode === "unsubscribe" ? "Unsubscribing + clearing" : "Clearing";
    const working = toast(`${verbing} ${label}… keep going, this runs in the background.`, "working", 0);

    let totalDeleted = 0;
    let autoUnsub = 0; // one-click / mailto / page auto-click
    let pageManual = 0; // unknown provider page opened for manual finish
    let groupPages = 0; // google group — opened to leave manually
    let noneUnsub = 0; // no unsubscribe method found

    for (let i = 0; i < senders.length; i++) {
      const s = senders[i];
      try {
        if (mode === "unsubscribe") {
          const u = await send("unsubscribe", { senderEmail: s.email });
          if (u.method === "page-group") groupPages++;
          else if (u.method === "page-manual") pageManual++;
          else if (u.method === "none") noneUnsub++;
          else if (u.unsubscribed) autoUnsub++;
        }
        const d = await send("delete", { senderEmail: s.email, period, permanent });
        totalDeleted += d.deleted || 0;
      } catch (err) {
        toast(`Error on ${s.email}: ${err.message}`, "error");
      }
    }

    if (mode === "unsubscribe") {
      const parts = [`Trashed ${totalDeleted} email${totalDeleted === 1 ? "" : "s"}`];
      if (autoUnsub) parts.push(`unsubscribed ${autoUnsub} automatically`);
      if (pageManual) parts.push(`${pageManual} page${pageManual === 1 ? "" : "s"} opened to finish manually`);
      if (groupPages) parts.push(`${groupPages} Google Group${groupPages === 1 ? "" : "s"} opened — leave manually if you want`);
      if (noneUnsub) parts.push(`${noneUnsub} had no unsubscribe link`);
      updateToast(working, parts.join(" · ") + ".", "success");
    } else {
      const verb = permanent ? "Permanently deleted" : "Trashed";
      updateToast(working, `${verb} ${totalDeleted} email${totalDeleted === 1 ? "" : "s"} from ${label}.`, "success");
    }

    // The API moved the mail to Trash, but the open Gmail view doesn't know yet,
    // so the rows linger. Hide this sender's still-visible rows in place — no
    // full refresh, so the scroll position is left exactly where it was.
    hideSenderRows(senders.map((s) => s.email));
  }

  // Uncheck every currently-selected Gmail row so the next pick starts clean.
  function deselectAll() {
    for (const row of document.querySelectorAll("tr.zA")) {
      const cb = row.querySelector('[role="checkbox"]');
      const checked = row.classList.contains("x7") || (cb && cb.getAttribute("aria-checked") === "true");
      if (checked && cb) cb.click();
    }
    lastKey = "__force__"; // force the action bar to re-evaluate and hide
  }

  // Hide the just-cleaned sender's still-visible rows in place. No full refresh,
  // so the user's scroll position never moves. Gmail rebuilds the list on its
  // own later, by which point these are genuinely gone from the view.
  function hideSenderRows(emails) {
    const set = new Set(emails.map((e) => e.toLowerCase()));
    for (const row of document.querySelectorAll("tr.zA")) {
      const email = (row.querySelector("span[email]")?.getAttribute("email") || "").toLowerCase();
      if (set.has(email)) row.style.display = "none";
    }
  }

  // ---- UI: toast (stacked, dismiss after `duration` ms; 0 = sticky) ----
  function toastContainer() {
    let c = document.getElementById("smc-toasts");
    if (!c) {
      c = document.createElement("div");
      c.id = "smc-toasts";
      document.body.appendChild(c);
    }
    return c;
  }
  function toast(msg, type, duration = 6000) {
    const t = document.createElement("div");
    t.className = `smc-toast smc-toast-${type}`;
    t.textContent = msg;
    toastContainer().appendChild(t);
    if (duration > 0) setTimeout(() => t.remove(), duration);
    return t;
  }
  function updateToast(t, msg, type, duration = 6000) {
    if (!t || !t.isConnected) return toast(msg, type, duration);
    t.className = `smc-toast smc-toast-${type}`;
    t.textContent = msg;
    if (duration > 0) setTimeout(() => t.remove(), duration);
    return t;
  }

  // ---- helpers ----
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function cssEscape(s) {
    return String(s).replace(/["\\]/g, "\\$&");
  }

  // ---- boot ----
  function init() {
    if (document.getElementById("smc-bar")) return;
    buildBar();
    // Gmail fires no clean selection event; poll the (cheap) DOM query.
    setInterval(refreshBar, 400);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
