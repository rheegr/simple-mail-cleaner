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
          if (el) el.textContent = `${c}`;
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
    const confirmBtn = modal.querySelector("#smc-confirm");
    const cancelBtn = modal.querySelector("#smc-cancel");
    const progress = modal.querySelector("#smc-progress");
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;

    const period = getPeriod();
    const permanent = getPermanent();
    let totalDeleted = 0;
    let autoUnsub = 0; // one-click / mailto / page auto-click
    let pageManual = 0; // unknown provider page opened for manual finish
    let groupPages = 0; // google group — opened to leave manually
    let noneUnsub = 0; // no unsubscribe method found

    for (let i = 0; i < senders.length; i++) {
      const s = senders[i];
      progress.textContent = `Working on ${s.email} (${i + 1}/${senders.length})…`;
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

    closeModal();
    lastKey = "__force__"; // force bar refresh after Gmail updates

    if (mode === "unsubscribe") {
      const parts = [`Trashed ${totalDeleted} email${totalDeleted === 1 ? "" : "s"}`];
      if (autoUnsub) parts.push(`unsubscribed ${autoUnsub} automatically`);
      if (pageManual) parts.push(`${pageManual} page${pageManual === 1 ? "" : "s"} opened to finish manually`);
      if (groupPages) parts.push(`${groupPages} Google Group${groupPages === 1 ? "" : "s"} opened — leave manually if you want`);
      if (noneUnsub) parts.push(`${noneUnsub} had no unsubscribe link`);
      toast(parts.join(" · ") + ".", "success");
    } else {
      const verb = permanent ? "Permanently deleted" : "Trashed";
      toast(`${verb} ${totalDeleted} email${totalDeleted === 1 ? "" : "s"}.`, "success");
    }
  }

  // ---- UI: toast ----
  function toast(msg, type) {
    const t = document.createElement("div");
    t.className = `smc-toast smc-toast-${type}`;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 6000);
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
