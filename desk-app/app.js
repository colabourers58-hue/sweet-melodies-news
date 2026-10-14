/* Editor's Desk — swipe right to publish, left to kill.
 *
 * Reads queue.json from its own folder. Each decision becomes a small file on the
 * newsroom repo's desk-decisions branch (GitHub contents API), then the
 * "Apply desk decisions" workflow is triggered to publish. The editor's key and
 * name stay in this phone's localStorage and go nowhere but api.github.com.
 */
(() => {
  "use strict";

  const DEFAULT_REPO = "colabourers58-hue/sweet-melodies-newsroom";
  const BRANCH = "desk-decisions";
  const WORKFLOW = "apply-decisions.yml";
  const UNDO_MS = 5000;
  const API = "https://api.github.com";

  const $ = (id) => document.getElementById(id);
  const store = {
    get(k, d) { try { const v = localStorage.getItem("desk." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("desk." + k, JSON.stringify(v)); } catch { /* private mode */ } },
    del(k) { try { localStorage.removeItem("desk." + k); } catch { /* ignore */ } },
  };

  let repo = DEFAULT_REPO;
  let stories = [];          // what's left to decide, in order
  let decided = store.get("decided", {});   // id -> {action, at}: hides cards until queue.json catches up
  let outbox = store.get("outbox", []);     // decisions waiting to reach GitHub
  let needDispatch = store.get("needDispatch", false);
  let pending = null;        // the decision inside its 5-second undo window
  let generated = null;
  let flushing = false;
  let authError = false;

  /* ---------- helpers ---------- */
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const curly = (s) => String(s ?? "").replace(/(^|[\s(\[“—-])"/g, "$1“").replace(/"/g, "”").replace(/(^|[\s(\[“—-])'/g, "$1‘").replace(/'/g, "’");
  const safeUrl = (u) => /^https?:\/\//i.test(u || "") ? u : "#";
  const b64 = (s) => { const bytes = new TextEncoder().encode(s); let bin = ""; bytes.forEach((b) => bin += String.fromCharCode(b)); return btoa(bin); };
  function ago(iso) {
    if (!iso) return "";
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
  }
  // The desk's explanation. New drafts carry plain sentences; older ones carry a list of
  // short reasons joined with ";", which reads better as separate sentences.
  function explain(r) {
    r = r || "It is waiting for an editor.";
    // Split between reasons ("...represented.; A legal matter...") but never inside a writer's
    // own sentence that happens to use a semicolon. Old short reasons have no full stops at all.
    const parts = (/[.!?”’)];\s/.test(r) ? r.split(/(?<=[.!?”’)]);\s+/) : /[.!?]/.test(r) ? [r] : r.split(/;\s+/))
      .map((x) => x.trim()).filter(Boolean);
    return parts.map((x) => {
      x = x.charAt(0).toUpperCase() + x.slice(1);
      return `<p>${esc(curly(/[.!?”’)]$/.test(x) ? x : x + "."))}</p>`;
    }).join("");
  }
  const ICON_FLAG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9.5"/></svg>';
  const ICON_STOP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="9.5"/><path d="M5.5 5.5l13 13"/></svg>';

  /* ---------- GitHub ---------- */
  async function gh(path, opts = {}) {
    const token = store.get("token", "");
    const r = await fetch(API + path, {
      ...opts,
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28",
                 ...(opts.body ? { "Content-Type": "application/json" } : {}) },
    });
    return r;
  }

  async function commitDecision(d) {
    const path = `/repos/${repo}/contents/data/decisions/${d.id}.json`;
    const content = b64(JSON.stringify({ action: d.action, editor: d.editor, at: d.at, headline: d.headline }, null, 1) + "\n");
    const body = { message: `${d.action} #${d.id} (${d.editor}, phone desk)`, content, branch: BRANCH };
    let r = await gh(path, { method: "PUT", body: JSON.stringify(body) });
    if (r.status === 422 || r.status === 409) {
      // A decision for this story is already waiting (changed mind before it was applied): overwrite it.
      const cur = await gh(`${path}?ref=${BRANCH}`);
      if (cur.ok) {
        body.sha = (await cur.json()).sha;
        r = await gh(path, { method: "PUT", body: JSON.stringify(body) });
      }
    }
    return r;
  }

  async function dispatch() {
    const r = await gh(`/repos/${repo}/actions/workflows/${WORKFLOW}/dispatches`, { method: "POST", body: JSON.stringify({ ref: "main" }) });
    return r.status === 204;
  }

  async function flush() {
    if (flushing || !store.get("token", "")) return;
    flushing = true;
    try {
      while (outbox.length) {
        const d = outbox[0];
        let r;
        try { r = await commitDecision(d); } catch { break; }   // offline: try again later
        if (r.status === 401 || r.status === 403 || r.status === 404) { authError = true; break; }
        if (!r.ok) break;
        authError = false;
        outbox.shift();
        store.set("outbox", outbox);
        needDispatch = true;
        store.set("needDispatch", true);
      }
      if (!outbox.length && needDispatch) {
        try {
          if (await dispatch()) { needDispatch = false; store.set("needDispatch", false); }
        } catch { /* offline */ }
      }
    } finally {
      flushing = false;
      renderSync();
      if (outbox.length || needDispatch) scheduleRetry();
    }
  }

  let retryTimer = null, retryDelay = 4000;
  function scheduleRetry() {
    if (authError) return;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { retryDelay = Math.min(retryDelay * 2, 120000); flush(); }, retryDelay);
  }
  window.addEventListener("online", () => { retryDelay = 4000; flush(); });

  function renderSync() {
    const el = $("sync");
    const n = outbox.length;
    el.className = "sync";
    if (authError) { el.textContent = `The desk key was refused, so ${n || "your"} decision${n === 1 ? "" : "s"} can’t be sent. Tap to fix.`; el.classList.add("on", "err"); }
    else if (n) { el.textContent = navigator.onLine ? `Sending ${n} decision${n === 1 ? "" : "s"}…` : `Offline · ${n} decision${n === 1 ? "" : "s"} will send when you reconnect`; el.classList.add("on"); }
    else if (needDispatch) { el.textContent = "Sent · asking the site to publish…"; el.classList.add("on"); }
  }

  /* ---------- queue ---------- */
  async function load() {
    $("status").textContent = "Loading…";
    try {
      const r = await fetch("queue.json?t=" + Date.now(), { cache: "no-store" });
      const data = await r.json();
      repo = data.repo || DEFAULT_REPO;
      generated = data.generated;
      const ids = new Set(data.stories.map((s) => String(s.id)));
      // Forget decisions the newsroom has already acted on (the story left the queue).
      // A story still listed six hours after a decision means the publish step failed: show it again.
      const stale = Date.now() - 6 * 3600e3;
      for (const id of Object.keys(decided)) {
        if (!ids.has(id) || new Date(decided[id].at).getTime() < stale) delete decided[id];
      }
      store.set("decided", decided);
      const skip = new Set([...Object.keys(decided), ...outbox.map((d) => String(d.id)), pending ? String(pending.id) : ""]);
      stories = data.stories.filter((s) => !skip.has(String(s.id)));
    } catch {
      $("status").textContent = "Offline — showing nothing new";
    }
    render();
  }

  function statusLine() {
    const n = stories.length;
    const when = generated ? ` · updated ${ago(generated)}` : "";
    $("status").textContent = (n ? `${n} ${n === 1 ? "story" : "stories"} waiting` : "Nothing waiting") + when;
  }

  /* ---------- cards ---------- */
  function cardHTML(s) {
    const stops = (s.blocked || []).map((b) => `<div class="chip stop">${ICON_STOP}<span>Can’t publish from the phone: ${esc(curly(b))}</span></div>`).join("");
    const why = `<section class="why"><h4>Why it’s held</h4>
        ${s.risk_note ? `<p class="risk">${esc(curly(s.risk_note))}</p>` : ""}
        ${explain(s.reason)}</section>`;
    const leader = s.church_leader ? `<div class="leader">${ICON_FLAG}<span>Could affect a church leader — read carefully</span></div>` : "";
    const photo = s.photo
      ? `<img src="${esc(s.photo)}" alt="" draggable="false">${s.credit ? `<span class="credit">Photo: ${esc(s.credit)}</span>` : ""}`
      : `<div class="nophoto"><img src="logo.png" alt="">No photo from the sources. The site will use a headline card.</div>`;
    const sources = (s.sources || []).map((x) =>
      `<li><a href="${esc(safeUrl(x.url))}" target="_blank" rel="noopener"><b>${esc(x.outlet)}</b> <span>${esc(curly(x.title || ""))}</span></a></li>`).join("");
    const warns = (s.warnings || []).map((w) => `<div class="chip warn">${ICON_FLAG}<span>${esc(curly(w))}</span></div>`).join("");
    return `
      <div class="tint yes"></div><div class="tint no"></div>
      <div class="stamp yes">Publish</div><div class="stamp no">Kill</div>
      <div class="ph${s.photo ? "" : " none"}">${photo}</div>${leader}
      <div class="wrap"><div class="body">
        <div class="meta"><span class="sec">${esc(s.category)}</span><span class="outlets">${s.outlets} ${s.outlets === 1 ? "outlet" : "outlets"} · ${esc(ago(s.created))}</span></div>
        <h2>${esc(curly(s.headline))}</h2>
        ${s.dek ? `<p class="dek">${esc(curly(s.dek))}</p>` : ""}
        ${stops}
        ${why}
        <div class="full">
          ${warns}
          ${(s.body || []).map((p) => `<p>${esc(curly(p))}</p>`).join("")}
          ${s.more ? `<p class="note">${s.more} more paragraph${s.more === 1 ? "" : "s"} in the full draft.</p>` : ""}
          ${sources ? `<h3>Sources</h3><ol>${sources}</ol>` : ""}
        </div>
      </div><div class="more">Read the story &amp; sources <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></div></div>`;
  }

  function render() {
    const deck = $("deck");
    deck.innerHTML = "";
    statusLine();
    renderSync();
    const top = stories[0];
    $("yes").disabled = !top || (top.blocked || []).length > 0;
    $("no").disabled = !top;
    $("undo").disabled = !pending;
    if (!top) {
      deck.innerHTML = `<div class="empty"><div class="mark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>
        <h1>All caught up</h1><p>New drafts arrive every three hours.${generated ? `<br>Queue updated ${esc(ago(generated))}.` : ""}</p>
        <button class="secondary" id="emptyRefresh">Check again</button></div>`;
      $("emptyRefresh").onclick = load;
      return;
    }
    stories.slice(0, 3).reverse().forEach((s, i, arr) => {
      const depth = arr.length - 1 - i;     // 0 = top
      const el = document.createElement("article");
      el.className = "card" + (depth ? " behind" : "");
      el.dataset.id = s.id;
      el.innerHTML = cardHTML(s);
      el.style.transform = `translateY(${depth * 10}px) scale(${1 - depth * 0.04})`;
      el.style.opacity = depth > 1 ? "0" : "1";
      el.setAttribute("aria-hidden", depth ? "true" : "false");
      deck.appendChild(el);
      if (!depth) bindSwipe(el, s);
    });
  }

  /* ---------- swipe ---------- */
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  function bindSwipe(el, s) {
    let x0 = 0, y0 = 0, dx = 0, dy = 0, t0 = 0, axis = null, id = null, moved = false;
    const yesT = el.querySelectorAll(".yes"), noT = el.querySelectorAll(".no");
    const blocked = (s.blocked || []).length > 0;

    function paint() {
      const r = dx / 18;
      el.style.transition = "none";
      el.style.transform = `translate(${dx}px, ${dy * 0.15}px) rotate(${r}deg)`;
      const p = Math.min(1, Math.abs(dx) / 110);
      yesT.forEach((n) => n.style.opacity = dx > 0 ? (blocked ? p * 0.3 : p) : 0);
      noT.forEach((n) => n.style.opacity = dx < 0 ? p : 0);
    }
    function reset() {
      el.style.transition = reduced ? "none" : "transform .32s cubic-bezier(.2,.9,.3,1.2)";
      el.style.transform = "translate(0,0) rotate(0)";
      yesT.forEach((n) => { n.style.transition = "opacity .2s"; n.style.opacity = 0; });
      noT.forEach((n) => { n.style.transition = "opacity .2s"; n.style.opacity = 0; });
    }

    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest("a")) return;
      id = e.pointerId; x0 = e.clientX; y0 = e.clientY; dx = dy = 0; t0 = performance.now(); axis = null; moved = false;
    });
    el.addEventListener("pointermove", (e) => {
      if (e.pointerId !== id) return;
      const mx = e.clientX - x0, my = e.clientY - y0;
      if (!axis && Math.hypot(mx, my) > 8) {
        axis = Math.abs(mx) > Math.abs(my) ? "x" : "y";
        if (axis === "x") el.setPointerCapture(id);
      }
      if (axis !== "x") return;
      moved = true; dx = mx; dy = my;
      paint();
    });
    const end = (e) => {
      if (e.pointerId !== id) return;
      id = null;
      if (axis !== "x") { if (!moved && e.type === "pointerup" && !e.target.closest("a")) toggle(el); return; }
      const v = Math.abs(dx) / Math.max(1, performance.now() - t0);
      const go = Math.abs(dx) > 110 || (v > 0.6 && Math.abs(dx) > 40);
      if (!go) return reset();
      if (dx > 0 && blocked) { reset(); toast("Fix this one on the desk first", s.blocked[0], false); return; }
      decide(dx > 0 ? "approve" : "reject", dx);
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", (e) => { if (e.pointerId === id) { id = null; reset(); } });
    el.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight" && !blocked) decide("approve");
      if (e.key === "ArrowLeft") decide("reject");
    });
  }

  function toggle(el) {
    el.classList.toggle("open");
    el.querySelector(".body").scrollTop = 0;
  }

  function flyOut(action, fromDx) {
    const el = $("deck").querySelector(".card:not(.behind)");
    if (!el) return Promise.resolve();
    const dir = action === "approve" ? 1 : -1;
    const w = innerWidth;
    el.querySelectorAll(action === "approve" ? ".yes" : ".no").forEach((n) => n.style.opacity = 1);
    if (reduced) return Promise.resolve();
    el.style.transition = "transform .28s cubic-bezier(.4,0,.8,.6)";
    el.style.transform = `translate(${dir * (w + 120)}px, ${fromDx ? 30 : 60}px) rotate(${dir * 22}deg)`;
    return new Promise((res) => setTimeout(res, 260));
  }

  /* ---------- decisions, undo, commit ---------- */
  let flying = false, wantUndo = false;
  async function decide(action, fromDx) {
    const s = stories[0];
    if (!s || flying || (action === "approve" && (s.blocked || []).length)) return;
    if (pending) commitPending();               // a second swipe confirms the first
    if (navigator.vibrate) navigator.vibrate(12);
    // The decision exists (and can be undone) from the moment of the swipe, not after the animation.
    stories.shift();
    pending = { id: s.id, action, story: s, editor: store.get("name", ""), at: new Date().toISOString(), headline: s.headline };
    pending.timer = setTimeout(commitPending, UNDO_MS);
    $("undo").disabled = false;
    toast(action === "approve" ? "Approved — going live" : "Rejected", s.headline, true);
    flying = true;
    await flyOut(action, fromDx);
    flying = false;
    if (wantUndo) { wantUndo = false; return undo(); }
    render();
  }

  function commitPending() {
    if (!pending) return;
    clearTimeout(pending.timer);
    const { id, action, editor, at, headline } = pending;
    decided[id] = { action, at };
    store.set("decided", decided);
    outbox.push({ id, action, editor, at, headline });
    store.set("outbox", outbox);
    pending = null;
    $("undo").disabled = true;
    hideToast();
    retryDelay = 4000;
    flush();
  }

  function undo() {
    if (flying) { wantUndo = true; return; }
    if (!pending) return;
    clearTimeout(pending.timer);
    stories.unshift(pending.story);
    pending = null;
    hideToast();
    render();
  }

  /* ---------- toast ---------- */
  let toastTimer = null;
  function toast(msg, sub, withUndo) {
    const t = $("toast"), bar = $("toastBar");
    $("toastMsg").innerHTML = `${esc(msg)}${sub ? `<small>${esc(curly(sub))}</small>` : ""}`;
    $("toastUndo").hidden = !withUndo;
    bar.style.transition = "none";
    bar.style.transform = "scaleX(1)";
    bar.hidden = !withUndo;
    t.classList.add("on");
    clearTimeout(toastTimer);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (withUndo) { bar.style.transition = `transform ${UNDO_MS}ms linear`; bar.style.transform = "scaleX(0)"; }
    }));
    toastTimer = setTimeout(hideToast, withUndo ? UNDO_MS : 3200);
  }
  function hideToast() { $("toast").classList.remove("on"); clearTimeout(toastTimer); }

  /* ---------- setup ---------- */
  function showSetup(first) {
    $("setup").hidden = false;
    $("refresh").hidden = $("settings").hidden = true;
    $("deck").hidden = true;
    $("actions").hidden = true;
    $("cancel").hidden = first;
    $("name").value = store.get("name", "");
    $("token").value = "";
    $("token").placeholder = store.get("token", "") ? "Leave blank to keep the current key" : "github_pat_…";
    $("setupErr").textContent = "";
  }
  function hideSetup() {
    $("setup").hidden = true;
    $("refresh").hidden = $("settings").hidden = false;
    $("deck").hidden = false;
    $("actions").hidden = false;
  }

  async function save() {
    const name = $("name").value.trim();
    const token = $("token").value.trim() || store.get("token", "");
    const err = $("setupErr");
    if (!name) { err.textContent = "Add your name: it goes on the record with every story you approve."; return; }
    if (!token) { err.textContent = "Paste the desk key."; return; }
    err.textContent = "Checking the key…";
    const prev = store.get("token", "");
    store.set("token", token);
    try {
      const r = await gh(`/repos/${repo}`);
      if (!r.ok) throw new Error(r.status === 401 ? "That key was not accepted." : "That key can’t open the newsroom repository.");
      const meta = await r.json();
      if (meta.permissions && !meta.permissions.push) throw new Error("That key can read but not write. It needs Contents: read and write.");
    } catch (e) {
      store.set("token", prev);
      err.textContent = e.message && !/fetch/i.test(e.message) ? e.message : "No connection. Try again when you’re online.";
      return;
    }
    store.set("name", name);
    authError = false;
    hideSetup();
    flush();
    load();
  }

  function settings() {
    if (pending) commitPending();
    showSetup(false);
  }

  /* ---------- boot ---------- */
  $("yes").onclick = () => decide("approve");
  $("no").onclick = () => decide("reject");
  $("undo").onclick = undo;
  $("toastUndo").onclick = undo;
  $("refresh").onclick = () => { flush(); load(); };
  $("settings").onclick = settings;
  $("sync").onclick = () => { if (authError) settings(); else { retryDelay = 4000; flush(); } };
  $("save").onclick = save;
  $("cancel").onclick = hideSetup;
  $("token").addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
  document.addEventListener("keydown", (e) => {
    if ($("setup").hidden === false || e.target.matches("input")) return;
    if (e.key === "ArrowRight" && !$("yes").disabled) decide("approve");
    if (e.key === "ArrowLeft" && !$("no").disabled) decide("reject");
    if ((e.metaKey || e.ctrlKey) && e.key === "z") undo();
  });
  // Leaving the app inside the undo window still sends the decision.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && pending) commitPending();
    if (document.visibilityState === "visible") { flush(); load(); }
  });

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

  if (!store.get("token", "") || !store.get("name", "")) showSetup(true);
  else hideSetup();
  load();
  flush();
})();
