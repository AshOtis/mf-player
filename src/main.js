/* MFP Player (unofficial) — Obsidian plugin.
 * A playlist player for the Music For Programming series.
 * Streams from the official feed; nothing is downloaded or re-hosted. */

'use strict';

const { Plugin, ItemView, Notice, requestUrl, PluginSettingTab, Setting, Menu } = require('obsidian');

const VIEW_TYPE = 'mfp-player-view';
const FEED_URL = 'https://musicforprogramming.net/rss.xml';
const SITE = 'https://musicforprogramming.net/';
const PATREON = 'https://www.patreon.com/MusicForProgramming/about';
const ARTWORK = 'https://musicforprogramming.net/img/folder.jpg';
const THEMES = ['mfp', 'invert', 'mono', 'amber', 'obsidian'];
const SAVE_EVERY_MS = 5000;

const DEFAULTS = {
  episodes: [],
  order: 'oldest',
  currentGuid: null,
  positions: {},
  played: {},
  favourites: {},
  favOnly: false,
  newGuids: [],
  volume: 0.8,
  lastChecked: null,
  theme: 'mfp',
  eq: true,
  statusBar: true
};

/* ---------- small helpers ---------- */

function el(tag, cls, text, parent) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  if (parent) parent.appendChild(n);
  return n;
}

function btn(parent, label, cls, title, onClick) {
  const b = el('button', 'mfp-btn ' + (cls || ''), label, parent);
  if (title) b.setAttribute('aria-label', title);
  b.addEventListener('click', onClick);
  return b;
}

function fmt(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const p = n => String(n).padStart(2, '0');
  return p(Math.floor(sec / 3600)) + ':' + p(Math.floor(sec % 3600 / 60)) + ':' + p(sec % 60);
}

function splitTitle(t) {
  const m = t.match(/^Episode\s+(\d+):\s*(.*)$/i);
  return m ? [m[1], m[2]] : ['', t];
}

function parseDuration(text) {
  if (!text) return 0;
  const parts = text.trim().split(':').map(Number);
  if (parts.some(isNaN)) return 0;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

function parseFeed(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Feed was not valid XML');
  return Array.from(doc.getElementsByTagName('item')).map(item => {
    const get = tag => ((item.getElementsByTagName(tag)[0] || {}).textContent || '').trim();
    const enclosure = item.getElementsByTagName('enclosure')[0];
    const url = (enclosure && enclosure.getAttribute('url')) || get('guid');
    const title = get('title');
    const m = title.match(/Episode\s+(\d+)/i);
    return {
      guid: get('guid') || url,
      url: url.replace(/^http:/, 'https:'),
      title,
      num: m ? Number(m[1]) : null,
      link: get('link').replace(/^http:/, 'https:'),
      date: get('pubDate'),
      duration: parseDuration(get('itunes:duration'))
    };
  }).filter(e => e.url);
}

/* =====================================================================
 * Plugin: owns the audio so playback continues with the view closed
 * ===================================================================== */

class MFPPlayerPlugin extends Plugin {
  async onload() {
    this.data = Object.assign({}, DEFAULTS, await this.loadData());
    this.status = '';
    this.error = '';
    this.refreshing = false;
    this.lastSave = 0;
    this.saveTimer = null;

    // EQ needs Web Audio, which needs CORS on the MP3 host. Falls back to plain audio.
    this.vizEnabled = true;
    this.vizConfirmed = false;
    this.ctx = this.analyser = this.freq = null;
    this.audio = this.makeAudio();

    this.registerView(VIEW_TYPE, leaf => new MFPView(leaf, this));
    this.addRibbonIcon('music', 'MFP Player', () => this.activateView());

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('mfp-status');
    this.statusEl.addEventListener('click', () => this.togglePlay());
    this.registerInterval(window.setInterval(() => this.updateStatusBar(), 1000));
    this.updateStatusBar();

    this.addCommands();
    this.addSettingTab(new MFPSettingTab(this.app, this));
    this.setupMediaSession();

    this.app.workspace.onLayoutReady(async () => {
      if (!this.data.episodes.length) await this.refresh();
    });
  }

  onunload() {
    this.storePosition(true);
    clearTimeout(this.saveTimer);
    this.saveData(this.data); // flush any pending save
    try { this.audio.pause(); this.audio.removeAttribute('src'); this.audio.load(); } catch (_) {}
    try { if (this.ctx) this.ctx.close(); } catch (_) {}
    if (this.statusEl) this.statusEl.remove();
  }

  addCommands() {
    const cmds = [
      ['open-player', 'Open player', () => this.activateView()],
      ['toggle-playback', 'Play / pause', () => this.togglePlay()],
      ['next-episode', 'Next episode', () => this.step(1)],
      ['previous-episode', 'Previous episode', () => this.prev()],
      ['random-episode', 'Random episode', () => this.random()],
      ['skip-forward', 'Skip forward 30 seconds', () => this.seek(this.audio.currentTime + 30)],
      ['skip-back', 'Skip back 30 seconds', () => this.seek(this.audio.currentTime - 30)],
      ['toggle-favourite', 'Favourite / unfavourite current episode', () => this.toggleFav()],
      ['toggle-favourites-only', 'Toggle favourites-only playlist', () => this.toggleFavOnly()],
      ['refresh-episodes', 'Refresh episode list', () => this.refresh()],
      ['cycle-theme', 'Cycle theme', () => this.cycleTheme()]
    ];
    for (const [id, name, cb] of cmds) this.addCommand({ id, name, callback: cb });
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  views() {
    return this.app.workspace.getLeavesOfType(VIEW_TYPE).map(l => l.view).filter(v => v instanceof MFPView);
  }

  changed() {
    for (const v of this.views()) v.render();
    this.updateStatusBar();
  }

  save(immediate) {
    clearTimeout(this.saveTimer);
    if (immediate) return this.saveData(this.data);
    this.saveTimer = setTimeout(() => this.saveData(this.data), 300);
  }

  /* ---------- audio engine ---------- */

  makeAudio() {
    const a = new Audio();
    a.preload = 'none';
    if (this.vizEnabled) a.crossOrigin = 'anonymous';
    a.volume = this.data.volume;
    a.addEventListener('timeupdate', () => this.storePosition());
    a.addEventListener('pause', () => { this.storePosition(true); this.setPlaybackState(); this.changed(); });
    a.addEventListener('play', () => { this.setPlaybackState(); this.changed(); });
    a.addEventListener('playing', () => this.onPlaying());
    a.addEventListener('error', () => this.onAudioError());
    a.addEventListener('ended', () => this.onEnded());
    return a;
  }

  ensureGraph() {
    if (!this.vizEnabled || this.analyser) return;
    try {
      this.ctx = new AudioContext();
      const src = this.ctx.createMediaElementSource(this.audio);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.75;
      this.freq = new Uint8Array(this.analyser.frequencyBinCount);
      src.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
    } catch (e) {
      this.disableViz('EQ unavailable: ' + e.message, false);
    }
  }

  async onPlaying() {
    if (!this.vizEnabled || this.vizConfirmed) return;
    try { if (this.ctx && this.ctx.state !== 'running') await this.ctx.resume(); } catch (_) {}
    setTimeout(() => {
      if (!this.vizEnabled || this.vizConfirmed) return;
      if (this.ctx && this.ctx.state !== 'running') this.disableViz('EQ unavailable (audio engine suspended)');
      else this.vizConfirmed = true;
    }, 800);
  }

  onAudioError() {
    if (!this.audio.src) return;
    if (this.vizEnabled && !this.vizConfirmed) {
      this.disableViz('EQ unavailable for this host — playing without it');
      return;
    }
    this.error = 'Could not load this episode (network or server issue).';
    this.changed();
  }

  disableViz(reason, resume = true) {
    const wasPlaying = !this.audio.paused || this.audio.readyState < 2;
    const t = this.audio.currentTime;
    this.vizEnabled = false;
    try { this.audio.pause(); this.audio.removeAttribute('src'); this.audio.load(); } catch (_) {}
    try { if (this.ctx) this.ctx.close(); } catch (_) {}
    this.ctx = this.analyser = this.freq = null;
    this.audio = this.makeAudio();
    this.status = reason;
    if (resume && this.data.currentGuid) {
      if (t > 0) this.data.positions[this.data.currentGuid] = t;
      this.playEpisode(this.data.currentGuid, wasPlaying);
    }
  }

  vizFrame(cols) {
    const out = new Array(cols).fill(0);
    if (!this.analyser || this.audio.paused) return out;
    this.analyser.getByteFrequencyData(this.freq);
    const nyquist = this.ctx.sampleRate / 2, n = this.freq.length;
    const lo = Math.log(40), hi = Math.log(14000);
    for (let c = 0; c < cols; c++) {
      const f1 = Math.exp(lo + (hi - lo) * c / cols), f2 = Math.exp(lo + (hi - lo) * (c + 1) / cols);
      const b1 = Math.max(1, Math.floor(f1 / nyquist * n)), b2 = Math.max(b1 + 1, Math.ceil(f2 / nyquist * n));
      let m = 0;
      for (let b = b1; b < b2 && b < n; b++) m = Math.max(m, this.freq[b]);
      out[c] = m;
    }
    return out;
  }

  /* ---------- feed ---------- */

  async refresh() {
    if (this.refreshing) return;
    this.refreshing = true;
    this.error = '';
    this.status = 'Checking for new episodes…';
    this.changed();
    try {
      const res = await requestUrl({ url: FEED_URL, throw: false });
      if (res.status >= 400) throw new Error('HTTP ' + res.status);
      const items = parseFeed(res.text);
      if (!items.length) throw new Error('Feed contained no episodes');

      const d = this.data;
      const firstLoad = d.episodes.length === 0;
      const known = new Set(d.episodes.map(e => e.guid));
      const feedGuids = new Set(items.map(e => e.guid));
      const fresh = firstLoad ? [] : items.filter(e => !known.has(e.guid)).map(e => e.guid);

      d.episodes = items; // episodes removed from the official feed disappear here too
      d.newGuids = Array.from(new Set(d.newGuids.filter(g => feedGuids.has(g)).concat(fresh)));
      d.lastChecked = Date.now();
      this.status = firstLoad
        ? `Loaded ${items.length} episodes`
        : fresh.length ? `${fresh.length} new episode${fresh.length > 1 ? 's' : ''} added` : 'No new episodes';
      await this.save(true);
    } catch (e) {
      this.status = '';
      this.error = 'Refresh failed: ' + e.message;
    } finally {
      this.refreshing = false;
      this.changed();
    }
  }

  /* ---------- playlist ---------- */

  playlist() {
    const key = e => e.num != null ? e.num : (Date.parse(e.date) || 0) / 1e12;
    let list = this.data.episodes.slice().sort((a, b) => key(a) - key(b));
    if (this.data.favOnly) list = list.filter(e => this.data.favourites[e.guid]);
    return this.data.order === 'newest' ? list.reverse() : list;
  }

  current() {
    return this.data.episodes.find(e => e.guid === this.data.currentGuid) || null;
  }

  storePosition(force) {
    const ep = this.current();
    if (!ep || !this.audio.src) return;
    const now = Date.now();
    if (!force && now - this.lastSave < SAVE_EVERY_MS) return;
    this.lastSave = now;
    this.data.positions[ep.guid] = this.audio.currentTime;
    this.save();
  }

  async playEpisode(guid, autoplay = true) {
    const d = this.data;
    const ep = d.episodes.find(e => e.guid === guid);
    if (!ep) return;
    if (d.currentGuid !== guid) this.storePosition(true);

    d.currentGuid = guid;
    this.error = '';
    d.newGuids = d.newGuids.filter(g => g !== guid);
    if (d.played[guid] && !d.positions[guid]) delete d.played[guid];

    this.ensureGraph();
    const start = Math.floor(d.positions[guid] || 0);
    this.audio.src = start > 0 ? `${ep.url}#t=${start}` : ep.url;
    this.save();
    this.updateMediaSession();
    this.changed();

    if (autoplay) {
      try {
        if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
        await this.audio.play();
      } catch (e) {
        if (this.audio.src) { this.error = 'Playback failed: ' + e.message; this.changed(); }
      }
    }
  }

  async togglePlay() {
    if (!this.data.currentGuid) {
      const list = this.playlist();
      const first = list.find(e => !this.data.played[e.guid]) || list[0];
      if (first) await this.playEpisode(first.guid);
      return;
    }
    if (!this.audio.src) return this.playEpisode(this.data.currentGuid);
    if (this.audio.paused) {
      try {
        if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
        await this.audio.play();
      } catch (e) { this.error = 'Playback failed: ' + e.message; this.changed(); }
    } else {
      this.audio.pause();
    }
  }

  async step(dir) {
    const list = this.playlist();
    const idx = list.findIndex(e => e.guid === this.data.currentGuid);
    const target = list[idx + dir];
    if (target) await this.playEpisode(target.guid);
    return !!target;
  }

  async prev() {
    if (this.audio.src && this.audio.currentTime > 5) { this.seek(0); return; }
    await this.step(-1);
  }

  async random() {
    const pool = this.playlist().filter(e => e.guid !== this.data.currentGuid);
    const unplayed = pool.filter(e => !this.data.played[e.guid]);
    const from = unplayed.length ? unplayed : pool;
    if (from.length) await this.playEpisode(from[Math.floor(Math.random() * from.length)].guid);
  }

  seek(t) {
    if (!this.audio.src) return;
    this.audio.currentTime = Math.max(0, t);
    this.storePosition(true);
  }

  setVolume(v) {
    this.data.volume = this.audio.volume = Math.round(Math.min(1, Math.max(0, v)) * 100) / 100;
    this.save();
  }

  async onEnded() {
    const ep = this.current();
    if (ep) {
      this.data.played[ep.guid] = true;
      delete this.data.positions[ep.guid];
      this.save();
    }
    const moved = await this.step(1);
    if (!moved) { this.status = 'End of playlist'; this.changed(); }
  }

  toggleFav(guid) {
    const g = guid || this.data.currentGuid;
    if (!g) return;
    const f = this.data.favourites;
    if (f[g]) delete f[g]; else f[g] = true;
    if (!Object.keys(f).length) this.data.favOnly = false;
    this.save();
    this.changed();
  }

  toggleFavOnly() {
    if (!Object.keys(this.data.favourites).length) {
      new Notice('MFP Player: favourite an episode first');
      return;
    }
    this.data.favOnly = !this.data.favOnly;
    this.save();
    this.changed();
  }

  cycleTheme() {
    this.data.theme = THEMES[(THEMES.indexOf(this.data.theme) + 1) % THEMES.length];
    this.save();
    this.changed();
  }

  /* ---------- status bar + media keys ---------- */

  updateStatusBar() {
    if (!this.statusEl) return;
    const ep = this.current();
    this.statusEl.toggleClass('mfp-hidden', !this.data.statusBar || !ep);
    if (!ep) return;
    const [no, name] = splitTitle(ep.title);
    const playing = this.audio.src && !this.audio.paused;
    const t = this.audio.src ? this.audio.currentTime : (this.data.positions[ep.guid] || 0);
    this.statusEl.setText(`${playing ? '▶' : '❚❚'} ${no ? no + ': ' : ''}${name} ${fmt(t)}`);
    this.statusEl.setAttribute('aria-label', playing ? 'MFP Player: click to pause' : 'MFP Player: click to play');
  }

  setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const handlers = {
      play: () => this.togglePlay(),
      pause: () => this.audio.pause(),
      nexttrack: () => this.step(1),
      previoustrack: () => this.prev(),
      seekbackward: () => this.seek(this.audio.currentTime - 30),
      seekforward: () => this.seek(this.audio.currentTime + 30)
    };
    for (const [action, fn] of Object.entries(handlers)) {
      try { navigator.mediaSession.setActionHandler(action, fn); } catch (_) {}
    }
  }

  updateMediaSession() {
    if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
    const ep = this.current();
    if (!ep) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: ep.title, artist: 'Music For Programming', album: 'Music For Programming',
      artwork: [{ src: ARTWORK, sizes: '1024x1024', type: 'image/jpeg' }]
    });
  }

  setPlaybackState() {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = this.audio.paused ? 'paused' : 'playing';
  }

  progress() {
    const ep = this.current();
    const a = this.audio;
    const dur = a.src && isFinite(a.duration) && a.duration > 0 ? a.duration : (ep ? ep.duration : 0);
    return {
      playing: !!a.src && !a.paused,
      buffering: !!a.src && !a.paused && a.readyState < 3,
      time: a.src ? a.currentTime : (ep ? this.data.positions[ep.guid] || 0 : 0),
      duration: dur
    };
  }
}

/* =====================================================================
 * Sidebar view
 * ===================================================================== */

const VIZ_ROWS = 7;
const GLYPHS = ['.', '-', 'o', '*', "'", '^', '•', ':'];

class MFPView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.dragging = false;
    this.raf = null;
    this.vizCols = 0;
    this.vizCells = [];
    this.levels = [];
    this.peaks = [];
    this.tick = 0;
    this.lastFrame = 0;
    this.renderedGuid = undefined;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'MFP Player'; }
  getIcon() { return 'music'; }

  async onOpen() {
    const root = this.contentEl;
    root.empty ? root.empty() : (root.textContent = '');
    root.addClass ? root.addClass('mfp-view') : root.classList.add('mfp-view');
    this.build(root);
    this.render();
    this.registerInterval(window.setInterval(() => this.renderProgress(), 500));
    const loop = ts => { this.raf = requestAnimationFrame(loop); this.vizLoop(ts); };
    this.raf = requestAnimationFrame(loop);
  }

  async onClose() {
    if (this.raf) cancelAnimationFrame(this.raf);
  }

  build(root) {
    const p = this.plugin;
    const $ = this.$ = {};

    const header = el('div', 'mfp-header', null, root);
    el('span', 'mfp-dim', 'mfp player // unofficial', header);
    const actions = el('span', 'mfp-actions', null, header);
    $.theme = btn(actions, '', 'c-yellow', 'Change theme', () => p.cycleTheme());
    $.eq = btn(actions, '', 'c-yellow', 'Show / hide the EQ', () => { p.data.eq = !p.data.eq; p.save(); p.changed(); });

    $.viz = el('pre', 'mfp-viz', null, root);

    const now = el('div', 'mfp-now', null, root);
    $.epno = el('div', 'mfp-epno', null, now);
    $.title = el('div', 'mfp-title', null, now);
    $.seek = el('input', 'mfp-seek', null, now);
    Object.assign($.seek, { type: 'range', min: 0, max: 1, step: 1, value: 0 });
    $.seek.setAttribute('aria-label', 'Seek');
    $.seek.addEventListener('input', () => { this.dragging = true; });
    $.seek.addEventListener('change', () => { p.seek(Number($.seek.value)); this.dragging = false; });

    const r1 = el('div', 'mfp-row c-green', null, now);
    btn(r1, '[prev]', '', 'Previous episode', () => p.prev());
    btn(r1, '[-30]', '', 'Back 30 seconds', () => p.seek(p.audio.currentTime - 30));
    $.toggle = btn(r1, '[play]', '', 'Play / pause', () => p.togglePlay());
    btn(r1, '[+30]', '', 'Forward 30 seconds', () => p.seek(p.audio.currentTime + 30));
    btn(r1, '[next]', '', 'Next episode', () => p.step(1));

    const r2 = el('div', 'mfp-row', null, now);
    $.time = el('span', 'mfp-dim', '00:00:00', r2);
    const vol = el('span', 'c-purple mfp-right', null, r2);
    btn(vol, '[v-]', '', 'Volume down', () => { p.setVolume(p.data.volume - 0.1); this.renderProgress(); });
    $.vol = el('span', 'mfp-dim', '', vol);
    btn(vol, '[v+]', '', 'Volume up', () => { p.setVolume(p.data.volume + 0.1); this.renderProgress(); });
    btn(vol, '[random]', '', 'Play a random episode', () => p.random());

    const links = el('div', 'mfp-links', null, now);
    $.tracklist = btn(links, '[tracklist]', 'c-blue', 'Open this episode on musicforprogramming.net',
      () => { const ep = p.current(); window.open(ep && ep.link ? ep.link : SITE); });
    $.refresh = btn(links, '[refresh]', 'c-blue', 'Check the feed for new episodes', async () => {
      await p.refresh();
      const n = this.contentEl.querySelector('.mfp-new');
      if (n) n.closest('li').scrollIntoView({ block: 'center' });
    });
    $.fav = btn(links, '[favourite]', 'c-yellow', 'Add / remove this episode from favourites', () => p.toggleFav());
    el('br', null, null, links);
    $.order = btn(links, '', 'c-yellow', 'Change playlist order', () => {
      p.data.order = p.data.order === 'oldest' ? 'newest' : 'oldest'; p.save(); p.changed();
    });
    $.favonly = btn(links, '', 'c-yellow', 'Play all episodes, or favourites only', () => p.toggleFavOnly());
    el('br', null, null, links);
    btn(links, '[patreon]', 'c-orange', 'Support Music For Programming on Patreon', () => window.open(PATREON));
    btn(links, '[musicforprogramming.net]', 'c-pink', 'Open the official site', () => window.open(SITE));
    $.status = el('div', 'mfp-comment mfp-status-line', null, now);

    $.list = el('ol', 'mfp-list', null, root);

    const footer = el('div', 'mfp-footer mfp-comment', null, root);
    $.stats = el('div', null, null, footer);
    $.checked = el('div', null, null, footer);
    el('div', null, '// love a track? buy it from the artist', footer);
  }

  rowMeta(e, time) {
    if (e.played && time == null) return 'played';
    const pos = time != null ? time : e.position;
    if (pos > 0 && e.duration) return Math.min(99, Math.floor(100 * pos / e.duration)) + '%';
    return '';
  }

  render() {
    if (!this.$) return;
    const p = this.plugin, d = p.data, $ = this.$;
    const cur = p.current();
    this.renderedGuid = d.currentGuid;

    this.contentEl.dataset.theme = d.theme;
    $.theme.textContent = `[${d.theme}]`;
    $.eq.textContent = d.eq ? '[eq on]' : '[eq off]';
    $.viz.toggleAttribute('hidden', !d.eq || !p.vizEnabled);

    if (cur) {
      const [no, name] = splitTitle(cur.title);
      $.epno.textContent = no ? `Episode ${no}:` : '';
      $.title.textContent = name;
    } else {
      $.epno.textContent = '';
      $.title.textContent = 'press [play]';
    }
    $.tracklist.toggleAttribute('hidden', !cur);
    $.fav.toggleAttribute('hidden', !cur);
    $.fav.textContent = cur && d.favourites[cur.guid] ? '[unfavourite]' : '[favourite]';
    $.order.textContent = d.order === 'oldest' ? '[oldest first]' : '[newest first]';
    const favCount = Object.keys(d.favourites).length;
    $.favonly.textContent = d.favOnly ? `[favourites only: ${favCount}]` : '[all episodes]';
    $.favonly.disabled = !favCount;

    const total = d.episodes.reduce((s, e) => s + (e.duration || 0), 0);
    $.stats.textContent = `// ${d.episodes.length} episodes · ${Math.floor(total / 3600)} hours`;
    $.checked.textContent = '// ' + (d.lastChecked
      ? 'checked ' + new Date(d.lastChecked).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).toLowerCase()
      : 'never checked');

    const list = $.list;
    list.textContent = '';
    for (const e of p.playlist()) {
      const li = el('li', null, null, list);
      if (e.guid === d.currentGuid) li.classList.add('is-current');
      if (d.played[e.guid]) li.classList.add('is-done');
      if (d.favourites[e.guid]) li.classList.add('is-fav');
      const [no, name] = splitTitle(e.title);
      const label = el('span', null, null, li);
      el('span', 'mfp-name', no ? `${no}: ${name}` : name, label);
      if (d.newGuids.includes(e.guid)) el('span', 'mfp-new', '*new', label);
      const position = d.positions[e.guid] || 0;
      el('span', 'mfp-meta', this.rowMeta({ ...e, played: !!d.played[e.guid], position }), li);
      li.setAttribute('aria-label', e.title);
      li.addEventListener('click', () => p.playEpisode(e.guid));
      li.addEventListener('contextmenu', ev => {
        ev.preventDefault();
        const menu = new Menu();
        menu.addItem(i => i.setTitle('Play').setIcon('play').onClick(() => p.playEpisode(e.guid)));
        menu.addItem(i => i.setTitle(d.favourites[e.guid] ? 'Unfavourite' : 'Favourite').setIcon('star')
          .onClick(() => p.toggleFav(e.guid)));
        menu.addItem(i => i.setTitle('Open tracklist').setIcon('external-link')
          .onClick(() => window.open(e.link || SITE)));
        menu.showAtMouseEvent(ev);
      });
    }
    this.renderProgress();
  }

  renderProgress() {
    if (!this.$) return;
    const p = this.plugin, $ = this.$;
    if (p.data.currentGuid !== this.renderedGuid) return this.render();
    const pr = p.progress();
    $.toggle.textContent = pr.buffering ? '[....]' : pr.playing ? '[stop]' : '[play]';
    if (!this.dragging) {
      $.seek.max = Math.max(1, Math.floor(pr.duration));
      $.seek.value = Math.floor(pr.time);
    }
    $.time.textContent = fmt(this.dragging ? $.seek.value : pr.time) + ' / ' + fmt(pr.duration);
    $.vol.textContent = ' ' + Math.round(p.data.volume * 100) + '% ';

    const msg = p.error || p.status;
    $.status.toggleAttribute('hidden', !msg);
    $.status.textContent = msg ? '// ' + msg.toLowerCase() : '';
    $.status.classList.toggle('is-error', !!p.error);
    $.refresh.disabled = p.refreshing;
    $.viz.toggleAttribute('hidden', !p.data.eq || !p.vizEnabled);

    const meta = this.contentEl.querySelector('li.is-current .mfp-meta');
    const cur = p.current();
    if (meta && cur) meta.textContent = this.rowMeta({ ...cur, played: false }, pr.time);
  }

  /* ---------- ASCII EQ ---------- */

  buildViz() {
    const pre = this.$.viz;
    const probe = el('span', null, '0000000000', pre);
    const cw = probe.getBoundingClientRect().width / 10 || 7.8;
    probe.remove();
    const cols = Math.max(16, Math.min(120, Math.floor(pre.clientWidth / cw)));
    if (cols === this.vizCols) return;
    this.vizCols = cols;
    pre.textContent = '';
    this.vizCells = [];
    for (let r = 0; r < VIZ_ROWS; r++) {
      const row = [];
      for (let c = 0; c < cols; c++) row.push(el('span', null, ' ', pre));
      pre.appendChild(document.createTextNode('\n'));
      this.vizCells.push(row);
    }
    this.levels = new Array(cols).fill(0);
    this.peaks = new Array(cols).fill(0);
  }

  vizLoop(ts) {
    if (!this.$ || this.$.viz.hidden || document.hidden || ts - this.lastFrame < 33) return;
    if (!this.$.viz.clientWidth) return; // view not visible
    this.lastFrame = ts;
    this.buildViz();
    const data = this.plugin.vizFrame(this.vizCols);
    this.tick++;
    const R = VIZ_ROWS - 1, cols = this.vizCols;
    const grid = this.vizCells.map(r => r.map(() => [' ', '']));
    for (let c = 0; c < cols; c++) {
      const target = Math.pow((data[c] || 0) / 255, 1.6);
      this.levels[c] += (target - this.levels[c]) * 0.45;
      this.peaks[c] = Math.max(this.levels[c], this.peaks[c] - 0.012);
      const color = 'v' + Math.min(5, Math.floor(6 * c / cols));
      const row = Math.round((1 - this.levels[c]) * R);
      if (this.levels[c] < 0.03) {
        grid[R][c] = ['_', color];
      } else {
        grid[row][c] = [GLYPHS[(c * 5 + Math.floor(this.levels[c] * 12) + (this.tick >> 4)) % GLYPHS.length], color];
        const pr = Math.round((1 - this.peaks[c]) * R);
        if (pr < row - 1) grid[pr][c] = ['·', 'pk'];
      }
    }
    for (let r = 0; r < VIZ_ROWS; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = this.vizCells[r][c], g = grid[r][c];
        if (cell.textContent !== g[0]) cell.textContent = g[0];
        if (cell.className !== g[1]) cell.className = g[1];
      }
    }
  }
}

/* =====================================================================
 * Settings
 * ===================================================================== */

class MFPSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const p = this.plugin;
    containerEl.empty();

    new Setting(containerEl).setName('Theme')
      .setDesc('"obsidian" follows your vault\'s own colours.')
      .addDropdown(dd => {
        THEMES.forEach(t => dd.addOption(t, t));
        dd.setValue(p.data.theme).onChange(v => { p.data.theme = v; p.save(); p.changed(); });
      });

    new Setting(containerEl).setName('Show EQ')
      .setDesc('ASCII frequency display above the player.')
      .addToggle(t => t.setValue(p.data.eq).onChange(v => { p.data.eq = v; p.save(); p.changed(); }));

    new Setting(containerEl).setName('Show in status bar')
      .setDesc('Current episode and time in the status bar. Click it to play or pause.')
      .addToggle(t => t.setValue(p.data.statusBar).onChange(v => { p.data.statusBar = v; p.save(); p.updateStatusBar(); }));

    new Setting(containerEl).setName('Playlist order')
      .addDropdown(dd => dd.addOption('oldest', 'Oldest first').addOption('newest', 'Newest first')
        .setValue(p.data.order).onChange(v => { p.data.order = v; p.save(); p.changed(); }));

    new Setting(containerEl).setName('Episode list')
      .setDesc('Checks the official feed for new episodes. Only happens when you ask.')
      .addButton(b => b.setButtonText('Refresh now').onClick(() => p.refresh()));

    new Setting(containerEl).setName('Support Music For Programming')
      .setDesc('The series makes no profit and carries no ads. Hosting and streaming cost money.')
      .addButton(b => b.setButtonText('Patreon').onClick(() => window.open(PATREON)));
  }
}

module.exports = MFPPlayerPlugin;
