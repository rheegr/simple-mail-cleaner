// InboxPurge content script — runs inside Gmail.
// Watches the message list for selected rows, surfaces an action bar, and on
// confirmation tells the background worker to Super Unsubscribe / Super Delete
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
    bar.id = "ipg-bar";
    bar.innerHTML = `
      <span id="ipg-bar-count"></span>
      <button id="ipg-unsub" class="ipg-btn ipg-btn-indigo">Super Unsubscribe</button>
      <button id="ipg-del" class="ipg-btn ipg-btn-red">Super Delete</button>
    `;
    document.body.appendChild(bar);
    barCount = bar.querySelector("#ipg-bar-count");
    bar.querySelector("#ipg-unsub").addEventListener("click", () => openModal("unsubscribe"));
    bar.querySelector("#ipg-del").addEventListener("click", () => openModal("delete"));
  }

  let lastKey = "";
  function refreshBar() {
    const senders = getSelectedSenders();
    const key = senders.map((s) => s.email).sort().join(",");
    if (key === lastKey) return;
    lastKey = key;
    if (senders.length === 0) {
      bar.classList.remove("ipg-show");
    } else {
      const n = senders.length;
      barCount.textContent = `${n} sender${n > 1 ? "s" : ""} selected`;
      bar.classList.add("ipg-show");
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
    modal.id = "ipg-overlay";

    const isUnsub = mode === "unsubscribe";
    const title = isUnsub ? "Super Unsubscribe" : "Super Delete";

    modal.innerHTML = `
      <div id="ipg-modal">
        <h2>${title}</h2>
        <p class="ipg-sub">Acts on <b>every</b> email from ${senders.length} sender${
      senders.length > 1 ? "s" : ""
    } below, not only the messages you selected.</p>
        <div id="ipg-senders"></div>
        <p class="ipg-label">Delete which emails?</p>
        <div id="ipg-periods"></div>
        ${
          isUnsub
            ? ""
            : `<label class="ipg-perm"><input type="checkbox" id="ipg-permanent"> Permanently delete (skip Trash, no recovery)</label>`
        }
        <div id="ipg-actions">
          <button id="ipg-cancel" class="ipg-btn ipg-btn-gray">Cancel</button>
          <button id="ipg-confirm" class="ipg-btn ${isUnsub ? "ipg-btn-indigo" : "ipg-btn-red"}">${
      isUnsub ? "Unsubscribe + Delete" : "Move to Trash"
    }</button>
        </div>
        <div id="ipg-progress"></div>
      </div>`;
    document.body.appendChild(modal);

    // sender rows with lazy counts
    const list = modal.querySelector("#ipg-senders");
    for (const s of senders) {
      const row = document.createElement("div");
      row.className = "ipg-srow";
      row.innerHTML = `<span class="ipg-sname">${escapeHtml(s.name)}</span>
        <span class="ipg-semail">${escapeHtml(s.email)}</span>
        <span class="ipg-scount" data-email="${escapeHtml(s.email)}">…</span>`;
      list.appendChild(row);
      send("count", { senderEmail: s.email })
        .then((c) => {
          const el = list.querySelector(`.ipg-scount[data-email="${cssEscape(s.email)}"]`);
          if (el) el.textContent = `${c}`;
        })
        .catch(() => {});
    }

    // period buttons
    const periodsEl = modal.querySelector("#ipg-periods");
    PERIODS.forEach((p) => {
      const b = document.createElement("button");
      b.className = "ipg-period" + (p.key === period ? " ipg-period-on" : "");
      b.textContent = p.label;
      b.addEventListener("click", () => {
        period = p.key;
        periodsEl.querySelectorAll(".ipg-period").forEach((x) => x.classList.remove("ipg-period-on"));
        b.classList.add("ipg-period-on");
        const permEl = modal.querySelector("#ipg-confirm");
        if (!isUnsub) permEl.textContent = permanent ? "Permanently Delete" : "Move to Trash";
      });
      periodsEl.appendChild(b);
    });

    if (!isUnsub) {
      modal.querySelector("#ipg-permanent").addEventListener("change", (e) => {
        permanent = e.target.checked;
        modal.querySelector("#ipg-confirm").textContent = permanent
          ? "Permanently Delete"
          : "Move to Trash";
      });
    }

    modal.querySelector("#ipg-cancel").addEventListener("click", () => closeModal());
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeModal();
    });
    modal.querySelector("#ipg-confirm").addEventListener("click", () =>
      runAction({ mode, senders, getPeriod: () => period, getPermanent: () => permanent })
    );
  }

  function closeModal() {
    if (modal) modal.remove();
    modal = null;
  }

  async function runAction({ mode, senders, getPeriod, getPermanent }) {
    const confirmBtn = modal.querySelector("#ipg-confirm");
    const cancelBtn = modal.querySelector("#ipg-cancel");
    const progress = modal.querySelector("#ipg-progress");
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
    t.className = `ipg-toast ipg-toast-${type}`;
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
    if (document.getElementById("ipg-bar")) return;
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
