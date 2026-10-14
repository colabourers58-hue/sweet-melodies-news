/* Sweet Melodies News: the live radio bar and the listen/ pages.
   Never autoplays. Remembers {station, playing} so the next page offers a one-tap Resume.
   The 94.3 stream is http only: on an https page browsers block it, so the player goes
   straight to "Listen on TuneIn". When the station enables SSL, live.py's STREAMS.https
   gets the URL and this script uses it with no other change. */
(function () {
  var el = document.getElementById('lv-data');
  if (!el) return;
  var cfg;
  try { cfg = JSON.parse(el.textContent); } catch (e) { return; }
  var st = cfg.st, sch = cfg.sch || { n: [], s: [] };
  var KEY = 'sm-live', RESUME_MS = 3 * 3600 * 1000, CONNECT_MS = 20000;
  var body = document.body;
  body.classList.add('has-live');

  function load() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } }
  function save(playing) {
    try { localStorage.setItem(KEY, JSON.stringify({ station: st.id, playing: !!playing, t: Date.now() })); } catch (e) {}
  }

  var secure = location.protocol === 'https:';
  var src = secure ? st.https : st.http;
  var audio = null, timer = null, state = 'idle';

  function all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function status(t) { all('[data-lv-status]').forEach(function (n) { n.textContent = t || ''; }); }

  var LABEL = { idle: 'Listen live', loading: 'Connecting…', playing: 'Pause', resume: 'Resume' };
  var STATUS = { idle: '', loading: 'Connecting…', playing: '', resume: 'Tap to resume' };
  function set(s) {
    state = s;
    body.setAttribute('data-lv', s);
    var bar = document.getElementById('lv-bar');
    if (bar) bar.setAttribute('data-state', s);
    status(STATUS[s]);
    all('[data-lv-label]').forEach(function (n) {
      if (!n.hasAttribute('data-lv-idle')) n.setAttribute('data-lv-idle', n.textContent);
      n.textContent = s === 'idle' ? n.getAttribute('data-lv-idle') : LABEL[s];
    });
    all('[data-lv-play]').forEach(function (b) {
      b.setAttribute('aria-pressed', s === 'playing' ? 'true' : 'false');
      b.setAttribute('aria-label', (s === 'playing' ? 'Pause ' : s === 'resume' ? 'Resume ' : 'Play ') + st.name + ' live');
    });
  }

  function fallback(why) {
    stop(true);
    set('out');
    all('[data-lv-play]').forEach(function (b) { b.hidden = true; });
    all('[data-lv-out]').forEach(function (a) { a.hidden = false; });
    if (why === 'https') all('[data-lv-https]').forEach(function (n) { n.hidden = false; });
    else status('Stream unavailable');
    save(false);
  }

  function stop(silent) {
    clearTimeout(timer);
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      try { audio.load(); } catch (e) {}
    }
    if (!silent) { set('idle'); save(false); }
  }

  function play() {
    if (!src) return fallback('https');
    if (!audio) {
      audio = new Audio();
      audio.preload = 'none';
      audio.addEventListener('playing', function () { clearTimeout(timer); set('playing'); save(true); });
      audio.addEventListener('waiting', function () { if (state === 'playing') status('Buffering…'); });
      audio.addEventListener('error', function () { if (audio.getAttribute('src')) fallback('error'); });
    }
    // A fresh URL each time: live radio resumes at the live edge, never from a cache.
    audio.src = src + (src.indexOf('?') < 0 ? '?' : '&') + '_=' + Date.now();
    set('loading');
    clearTimeout(timer);
    timer = setTimeout(function () { if (state === 'loading') fallback('timeout'); }, CONNECT_MS);
    var p = audio.play();
    if (p && p.catch) p.catch(function (e) {
      if (e && e.name === 'NotAllowedError') { stop(true); set('idle'); }
      else if (e && e.name !== 'AbortError') fallback('error');
    });
    meta();
  }

  function toggle() { if (state === 'playing' || state === 'loading') stop(); else play(); }
  all('[data-lv-play]').forEach(function (b) { b.addEventListener('click', toggle); });

  // ---- what's on ---------------------------------------------------------------------
  function clock(min) {
    var d = new Date(min * 60000), h = d.getUTCHours(), m = d.getUTCMinutes();
    return (h % 12 || 12) + ':' + (m < 10 ? '0' : '') + m + (h < 12 ? ' am' : ' pm');
  }
  function onAir() {
    var now = Date.now() / 60000;
    for (var i = 0; i < sch.s.length; i++) {
      var r = sch.s[i];
      if (r[0] <= now && now < r[0] + r[1]) return { name: sch.n[r[2]], end: r[0] + r[1] };
    }
    return null;
  }
  var current = null;
  function tick() {
    var o = onAir();
    current = o;
    all('[data-lv-show]').forEach(function (n) {
      if (!n.hasAttribute('data-lv-default')) n.setAttribute('data-lv-default', n.textContent);
      if (!o) { n.textContent = n.getAttribute('data-lv-default'); return; }
      n.textContent = n.closest('.lv-bar') ? o.name + ' · until ' + clock(o.end) : o.name;
    });
    var t = Date.now() / 1000;
    all('.lv-list li').forEach(function (li) {
      var a = +li.getAttribute('data-a'), b = +li.getAttribute('data-b');
      li.classList.toggle('on', a <= t && t < b);
      li.classList.toggle('past', b <= t);
    });
    all('[data-lv-earlier]').forEach(function (b) {
      var list = b.nextElementSibling;
      b.hidden = !list || list.classList.contains('lv-all-day') || !list.querySelector('li.past');
    });
    meta();
  }
  all('[data-lv-earlier]').forEach(function (b) {
    b.addEventListener('click', function () { b.nextElementSibling.classList.add('lv-all-day'); b.hidden = true; });
  });
  function meta() {
    if (!('mediaSession' in navigator) || !window.MediaMetadata) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: current ? current.name : st.name, artist: st.name + ' · ' + st.city,
        artwork: [{ src: (cfg.root || '') + 'assets/avatar-512.png', sizes: '512x512', type: 'image/png' }]
      });
      navigator.mediaSession.setActionHandler('play', play);
      navigator.mediaSession.setActionHandler('pause', function () { stop(); });
    } catch (e) {}
  }
  tick();
  setInterval(tick, 30000);

  // ---- start state -------------------------------------------------------------------
  if (secure && !st.https) { fallback('https'); return; }
  var last = load();
  if (last.playing && last.station === st.id && Date.now() - (last.t || 0) < RESUME_MS) set('resume');
  else set('idle');
  // Leaving while playing keeps "playing" so the next page offers Resume.
  window.addEventListener('pagehide', function () { if (state === 'playing') save(true); });
})();
