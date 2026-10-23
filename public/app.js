(() => {
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const r2 = x => Math.round(x * 100) / 100;
const money = x => r2(x).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (x, d = 2) => x.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtX = m => '×' + num(m);
const rand = (a, b) => a + Math.random() * (b - a);
const h = html => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const short = x => x >= 1000 ? num(x / 1000, x % 1000 ? 1 : 0) + 'k' : String(r2(x)).replace('.', ',');

/* ================= État et serveur ================= */
// Le solde, le hasard et les gains sont gérés par le serveur (SQLite) ; on ne garde ici qu'une copie pour l'affichage.
const DEFAULT = { name: 'Joueur', username: null, guest: false, balance: 0, favs: ['slots'], stats: { wagered: 0, won: 0, played: 0, best: 0 }, hist: [], sound: true, bets: {} };
let S = JSON.parse(JSON.stringify(DEFAULT)), authed = false;
class ApiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }
// Adresse de l'API (config.js) : la fonction Edge Supabase en ligne, « /api » avec le serveur Node local.
const API_URL = (window.MD_CONFIG && window.MD_CONFIG.apiUrl) || '/api';
// Exécute la fonction Edge dans la région de la base de données (beaucoup moins d'allers-retours lents).
const apiUrl = path => {
  const u = new URL(API_URL + path, location.href), region = window.MD_CONFIG && window.MD_CONFIG.region;
  if (region) u.searchParams.set('forceFunctionRegion', region);
  return u.href;
};
// Jeton de session, envoyé dans l'en-tête X-MD-Session (le site et l'API sont sur des domaines différents).
const TOKEN_KEY = 'maisondor:session';
const session = {
  get() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return session.mem || ''; } },
  set(t) { session.mem = t; try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch (e) {} }
};
async function api(path, body, { method, keepalive } = {}) {
  let r;
  const headers = {}, token = session.get();
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['X-MD-Session'] = token;
  try {
    r = await fetch(apiUrl(path), {
      method: method || (body !== undefined ? 'POST' : 'GET'), keepalive, headers, body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch (e) { throw new ApiError('Connexion au serveur impossible. Vérifiez votre réseau.', 0); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { if (r.status === 401 && !path.startsWith('/auth')) { session.set(''); needAuth(); } throw new ApiError(data.error || 'Erreur du serveur.', r.status); }
  if (data.token) session.set(data.token);
  return data;
}
// Appel d'un jeu (POST si body est fourni) : affiche l'erreur et renvoie null en cas d'échec.
async function play(path, body) {
  try { return await api(path, body); }
  catch (e) { if (e.status !== 401) { toast(e.message, 'err'); sfx.lose(); } return null; }
}
function applyProfile(p) {
  const u = p.user;
  Object.assign(S, { name: u.name, username: u.username, guest: u.guest, sound: u.sound, favs: u.favs, bets: u.bets || {}, hist: p.hist || [] });
  held = 0; W.sync(p.wallet);
}
let saveT;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => { if (authed) api('/me', { name: S.name, sound: S.sound, favs: S.favs, bets: S.bets }, { method: 'PATCH' }).catch(() => {}); }, 400);
}

/* ================= Son ================= */
// Tout est synthétisé avec Web Audio : aucun fichier à télécharger.
// Deux bus : les effets (réglage « Effets sonores », enregistré sur le serveur)
// et la musique (réglage « Musique », mémorisé sur l'appareil).
let ac = null, bus = null, noiseBuf = null;
const pref = {
  get(k, d) { try { const v = localStorage.getItem('maisondor:' + k); return v === null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('maisondor:' + k, v); } catch (e) {} }
};
function audio() {
  if (!ac) {
    try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return; }
    const comp = ac.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 4; comp.connect(ac.destination);
    const master = ac.createGain(); master.gain.value = .9; master.connect(comp);
    const sfxG = ac.createGain(); sfxG.connect(master);
    const musG = ac.createGain(); musG.gain.value = 0; musG.connect(master);
    // Réverbération légère, partagée par la musique et les jingles.
    const rev = ac.createConvolver(), len = ac.sampleRate * 2.2, ir = ac.createBuffer(2, len, ac.sampleRate);
    for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2); }
    rev.buffer = ir; const revG = ac.createGain(); revG.gain.value = .32; rev.connect(revG).connect(master);
    noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const nd = noiseBuf.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    bus = { master, sfx: sfxG, music: musG, rev };
    music.sync();
  }
  if (ac.state === 'suspended') ac.resume();
}
document.addEventListener('pointerdown', audio, { passive: true });
document.addEventListener('keydown', audio);
document.addEventListener('visibilitychange', () => { if (!ac) return; document.hidden ? ac.suspend() : ac.resume(); });
const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
// Note de synthèse : enveloppe, glissando et envoi facultatif vers la réverbération.
function tone(f, t0, d, type = 'sine', v = .08, fEnd, { out, at, verb = 0, attack = .004 } = {}) {
  if (!ac) return;
  if (!out && !S.sound) return;
  const t = at !== undefined ? at : ac.currentTime + t0, o = ac.createOscillator(), g = ac.createGain();
  o.type = type; o.frequency.setValueAtTime(f, t); if (fEnd) o.frequency.exponentialRampToValueAtTime(fEnd, t + d);
  g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(v, t + attack); g.gain.exponentialRampToValueAtTime(.0001, t + d);
  o.connect(g).connect(out || bus.sfx); if (verb) { const s = ac.createGain(); s.gain.value = verb; g.connect(s).connect(bus.rev); }
  o.start(t); o.stop(t + d + .05);
}
// Bruit filtré : balais, charleston, souffle, roulement.
function noise(t0, d, v = .1, { type = 'highpass', freq = 6000, q = .7, out, at, fEnd } = {}) {
  if (!ac) return;
  if (!out && !S.sound) return;
  const t = at !== undefined ? at : ac.currentTime + t0, src = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
  src.buffer = noiseBuf; src.loop = true; f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
  if (fEnd) f.frequency.exponentialRampToValueAtTime(fEnd, t + d);
  g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(v, t + .005); g.gain.exponentialRampToValueAtTime(.0001, t + d);
  src.connect(f).connect(g).connect(out || bus.sfx); src.start(t, Math.random()); src.stop(t + d + .05);
}
const sfx = {
  click() { tone(660, 0, .05, 'triangle', .06); },
  tick() { tone(900, 0, .03, 'square', .018); },
  stop() { tone(190, 0, .13, 'triangle', .18, 70); noise(0, .08, .05, { type: 'lowpass', freq: 900 }); },
  lose() { tone(330, 0, .22, 'triangle', .07, 260); tone(247, .16, .38, 'triangle', .07, 180, { verb: .3 }); },
  coin() { tone(1318, 0, .08, 'square', .04); tone(1760, .07, .22, 'square', .04, 0, { verb: .25 }); },
  // Arpège majeur dont la longueur suit l'importance du gain, puis un accord tenu.
  win(n = 3) {
    [523, 659, 784, 1047, 1319, 1568].slice(0, n).forEach((f, i) => tone(f, i * .085, .3, 'triangle', .11, 0, { verb: .35 }));
    const end = n * .085;
    [523, 659, 784].forEach(f => tone(f * 2, end, .9, 'sine', .05, 0, { verb: .5, attack: .02 }));
    if (n >= 5) for (let i = 0; i < 10; i++) tone(rand(1800, 3200), end + i * .05, .12, 'sine', .03, 0, { verb: .4 });
  },
  // Fanfare des gros gains : cuivres synthétiques + pluie de pièces.
  fanfare(level = 1) {
    const seq = [[60, 64, 67], [62, 65, 69], [64, 67, 72], [65, 69, 72, 77]];
    seq.forEach((ch, i) => ch.forEach(m => tone(mtof(m + 12), i * .16, i === 3 ? 1.6 : .2, 'sawtooth', .035, 0, { verb: .5, attack: .015 })));
    [48, 55, 60].forEach(m => tone(mtof(m), .48, 1.6, 'triangle', .09, 0, { verb: .4, attack: .02 }));
    noise(.48, 1.4, .05, { type: 'highpass', freq: 7000 });
    for (let i = 0; i < 14 * level; i++) tone(rand(1500, 3000), .5 + i * .07, .1, 'square', .018, 0, { verb: .3 });
  },
  card() { noise(0, .07, .09, { type: 'bandpass', freq: 3200, q: 1.2 }); tone(1500, 0, .05, 'triangle', .03, 500); },
  star() { tone(880, 0, .08, 'sine', .08, 1320); tone(1760, .07, .2, 'sine', .04, 0, { verb: .4 }); },
  boom() { tone(140, 0, .7, 'sawtooth', .16, 30); noise(0, .9, .22, { type: 'lowpass', freq: 2400, fEnd: 120 }); },
  gem(i = 0) { const f = 880 * Math.pow(1.06, i); tone(f, 0, .12, 'triangle', .08, 0, { verb: .3 }); tone(f * 1.5, .06, .2, 'sine', .05, 0, { verb: .4 }); },
  peg() { tone(rand(1300, 1900), 0, .04, 'sine', .03); },
  launch() { tone(260, 0, .5, 'sawtooth', .05, 90); noise(0, 1.1, .08, { type: 'bandpass', freq: 400, fEnd: 2400, q: .8 }); },
  whoosh() { noise(0, .45, .07, { type: 'bandpass', freq: 500, fEnd: 3000, q: 1.4 }); },
  roll() { for (let i = 0; i < 6; i++) noise(i * .07, .06, .06, { type: 'bandpass', freq: rand(900, 1600), q: 3 }); }
};

/* ---------- Musique d'ambiance ---------- */
// Boucle lounge-jazz générée en direct : nappes, contrebasse, balais et vibraphone.
// L'ambiance s'adapte : calme à l'accueil, plus présente en jeu, tendue pendant le vol de la fusée.
const music = (() => {
  const MOODS = {
    lobby: { bpm: 88, cutoff: 1300, hats: .55, mel: .22, vol: .5 },
    game: { bpm: 100, cutoff: 1900, hats: .8, mel: .3, vol: .42 },
    tense: { bpm: 124, cutoff: 3200, hats: 1, mel: .12, vol: .46 }
  };
  // ii-V-I-VI en ré mineur / do majeur, puis variation (accords en notes MIDI, basse à part).
  const PROG = [
    { bass: 38, pad: [53, 57, 60, 64] }, { bass: 43, pad: [53, 59, 64, 69] },
    { bass: 48, pad: [52, 55, 59, 62] }, { bass: 45, pad: [55, 61, 64, 70] },
    { bass: 41, pad: [57, 60, 64, 67] }, { bass: 40, pad: [55, 59, 62, 65] },
    { bass: 45, pad: [55, 60, 64, 67] }, { bass: 43, pad: [53, 57, 59, 65] }
  ];
  let on = pref.get('music', '1') === '1', mood = 'lobby', timer = 0, step = 0, next = 0, bar = 0;
  const m = () => MOODS[mood];
  function pad(ch, t, dur) {
    const f = ac.createBiquadFilter(), g = ac.createGain();
    f.type = 'lowpass'; f.frequency.value = m().cutoff; f.Q.value = .4;
    g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(.045, t + .5); g.gain.setValueAtTime(.045, t + dur - .4); g.gain.exponentialRampToValueAtTime(.0001, t + dur + .3);
    f.connect(g); g.connect(bus.music); const s = ac.createGain(); s.gain.value = .5; g.connect(s).connect(bus.rev);
    for (const n of ch) for (const det of [-6, 6]) { const o = ac.createOscillator(); o.type = 'sawtooth'; o.frequency.value = mtof(n); o.detune.value = det; o.connect(f); o.start(t); o.stop(t + dur + .4); }
  }
  function bass(n, t, len) {
    const o = ac.createOscillator(), o2 = ac.createOscillator(), f = ac.createBiquadFilter(), g = ac.createGain();
    o.type = 'triangle'; o2.type = 'sine'; o.frequency.value = o2.frequency.value = mtof(n);
    f.type = 'lowpass'; f.frequency.value = 700;
    g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(.2, t + .01); g.gain.exponentialRampToValueAtTime(.0001, t + len);
    o.connect(f); o2.connect(f); f.connect(g).connect(bus.music); o.start(t); o2.start(t); o.stop(t + len + .05); o2.stop(t + len + .05);
  }
  function vibe(n, t) {
    tone(mtof(n), 0, 1.1, 'sine', .05, 0, { out: bus.music, at: t, verb: .6, attack: .005 });
    tone(mtof(n) * 4, 0, .25, 'sine', .012, 0, { out: bus.music, at: t });
  }
  function tick() {
    const spb = 60 / m().bpm / 4; // durée d'une double croche
    while (next < ac.currentTime + .25) {
      const t = next, s = step % 16, ch = PROG[bar % PROG.length], nx = PROG[(bar + 1) % PROG.length];
      const swing = s % 2 ? spb * .28 : 0, tt = t + swing;
      if (s === 0) pad(ch.pad, t, spb * 16);
      // Contrebasse « walking » : fondamentale, quinte, octave, puis approche chromatique.
      if (s % 4 === 0) { const walk = [ch.bass, ch.bass + 7, ch.bass + 12, nx.bass + (Math.random() < .5 ? 1 : -1)]; bass(walk[s / 4], t, spb * 3.6); }
      if (mood === 'tense' && s % 2 === 1) bass(ch.bass + 12, tt, spb * .9);
      // Batterie aux balais.
      if (s === 0 || s === 8) { tone(110, 0, .25, 'sine', mood === 'lobby' ? .12 : .2, 45, { out: bus.music, at: t }); }
      if (s === 4 || s === 12) noise(0, .22, .05, { type: 'bandpass', freq: 2200, q: .6, out: bus.music, at: t });
      if (s % 2 === 0 || (mood === 'tense')) if (Math.random() < m().hats) noise(0, .05, s % 4 === 2 ? .045 : .025, { freq: 8000, out: bus.music, at: tt });
      // Vibraphone : notes de l'accord, parfois à l'octave.
      if (s % 2 === 0 && Math.random() < m().mel) vibe(ch.pad[Math.floor(Math.random() * 4)] + (Math.random() < .5 ? 12 : 24), tt);
      next += spb; step++; if (step % 16 === 0) bar++;
    }
  }
  function start() {
    if (timer || !ac || !on) return;
    next = ac.currentTime + .1; step = 0;
    bus.music.gain.cancelScheduledValues(ac.currentTime); bus.music.gain.setTargetAtTime(m().vol, ac.currentTime, .8);
    timer = setInterval(tick, 60); tick();
  }
  function stop() {
    if (!timer) return; clearInterval(timer); timer = 0;
    if (bus) { bus.music.gain.cancelScheduledValues(ac.currentTime); bus.music.gain.setTargetAtTime(0, ac.currentTime, .3); }
  }
  return {
    get on() { return on; },
    sync() { if (!ac) return; on ? start() : stop(); },
    toggle() { on = !on; pref.set('music', on ? '1' : '0'); audio(); this.sync(); },
    mood(x) { if (!MOODS[x] || mood === x) return; mood = x; if (timer && bus) bus.music.gain.setTargetAtTime(m().vol, ac.currentTime, .6); },
    // Baisse la musique le temps d'un jingle.
    duck(sec = 2.5) {
      if (!timer || !bus) return; const g = bus.music.gain, t = ac.currentTime;
      g.cancelScheduledValues(t); g.setTargetAtTime(m().vol * .25, t, .08); g.setTargetAtTime(m().vol, t + sec, .6);
    }
  };
})();

/* ================= Toasts, pièces, célébrations ================= */
function toast(text, type = 'info') {
  const t = h(`<div class="toast ${type}"></div>`); t.textContent = text; $('#toasts').appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, 2400);
}
const fx = $('#fx'), fctx = fx.getContext('2d'); let parts = [], fraf = 0;
function fitFx() { const d = Math.min(devicePixelRatio || 1, 2); fx.width = innerWidth * d; fx.height = innerHeight * d; fctx.setTransform(d, 0, 0, d, 0, 0); }
addEventListener('resize', fitFx); fitFx();
const CONFETTI = ['#f6dd93', '#d12c45', '#3ecf8e', '#4fb3ff', '#ff6fae', '#ffffff'];
// Pièces d'or et, pour les beaux gains, confettis colorés et étincelles.
function burst(x, y, n, { confetti = 0, rain = false } = {}) {
  if (reduce) return;
  for (let i = 0; i < n; i++) parts.push(rain
    ? { k: 'coin', x: rand(0, innerWidth), y: rand(-200, -20), vx: rand(-1, 1), vy: rand(2, 7), r: rand(7, 12), rot: rand(0, 6.28), vr: rand(-.3, .3) }
    : { k: 'coin', x: x + rand(-40, 40), y, vx: rand(-4.5, 4.5), vy: rand(-14, -5), r: rand(6, 10), rot: rand(0, 6.28), vr: rand(-.3, .3) });
  for (let i = 0; i < confetti; i++) parts.push({ k: 'conf', x: x + rand(-30, 30), y, vx: rand(-7, 7), vy: rand(-16, -6), w: rand(5, 9), hgt: rand(9, 15), rot: rand(0, 6.28), vr: rand(-.25, .25), c: CONFETTI[i % CONFETTI.length], drag: rand(.96, .99) });
  for (let i = 0; i < confetti / 2; i++) { const a = rand(0, 6.28), v = rand(3, 9); parts.push({ k: 'spark', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1 }); }
  if (!fraf) fraf = requestAnimationFrame(fxLoop);
}
function fxLoop() {
  fctx.clearRect(0, 0, innerWidth, innerHeight);
  parts = parts.filter(p => p.y < innerHeight + 30 && (p.k !== 'spark' || p.life > 0));
  for (const p of parts) {
    if (p.k === 'spark') {
      p.x += p.vx; p.y += p.vy; p.vx *= .92; p.vy *= .92; p.life -= .03;
      fctx.globalAlpha = Math.max(0, p.life); fctx.fillStyle = '#fff6cf';
      fctx.beginPath(); fctx.arc(p.x, p.y, 2.2, 0, 6.283); fctx.fill(); fctx.globalAlpha = 1; continue;
    }
    if (p.k === 'conf') {
      p.vy += .3; p.vx *= p.drag; p.x += p.vx + Math.sin(p.rot * 2); p.y += p.vy; p.rot += p.vr;
      fctx.save(); fctx.translate(p.x, p.y); fctx.rotate(p.rot); fctx.scale(1, Math.cos(p.rot * 3));
      fctx.fillStyle = p.c; fctx.fillRect(-p.w / 2, -p.hgt / 2, p.w, p.hgt); fctx.restore(); continue;
    }
    p.vy += .38; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
    fctx.save(); fctx.translate(p.x, p.y); fctx.scale(Math.abs(Math.cos(p.rot)) * .9 + .1, 1);
    fctx.beginPath(); fctx.arc(0, 0, p.r, 0, 6.283); fctx.fillStyle = '#e7bf5a'; fctx.fill();
    fctx.lineWidth = 1.5; fctx.strokeStyle = '#8a6a22'; fctx.stroke();
    fctx.beginPath(); fctx.arc(0, 0, p.r * .55, 0, 6.283); fctx.strokeStyle = '#b98a2c'; fctx.stroke(); fctx.restore();
  }
  fraf = parts.length ? requestAnimationFrame(fxLoop) : 0;
  if (!fraf) fctx.clearRect(0, 0, innerWidth, innerHeight);
}
// Montant qui s'envole au-dessus de l'élément gagnant.
function floatText(el, text, cls = 'good') {
  if (reduce || !el) return;
  const r = el.getBoundingClientRect(), t = h(`<div class="float-txt ${cls}"></div>`);
  t.textContent = text; t.style.left = r.left + r.width / 2 + 'px'; t.style.top = r.top + r.height * .4 + 'px';
  document.body.appendChild(t); setTimeout(() => t.remove(), 1500);
}
// Éclair doré (gain) ou rouge (perte) sur la scène du jeu.
function flash(el, kind) {
  const st = el && el.closest('.g-stage'); if (!st) return;
  st.classList.remove('flash-win', 'flash-lose'); void st.offsetWidth; st.classList.add('flash-' + kind);
}
function celebrate(el, mult, amount) {
  const r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  burst(cx, cy, Math.min(90, Math.round(8 + mult * 4)), { confetti: mult >= 2 ? Math.min(120, Math.round(mult * 12)) : 0 });
  flash(el, 'win');
  if (amount > 0) floatText(el, '+' + money(amount));
  if (mult >= 5) bigWin(mult, amount, cx, cy);
  else sfx.win(mult >= 3 ? 5 : 3);
  if (mult >= 10 && navigator.vibrate) navigator.vibrate([50, 30, 90]);
}
function defeat(el, hard = false) {
  flash(el, 'lose');
  if (hard) { const st = el && el.closest('.g-stage'); if (st) { st.classList.remove('shake'); void st.offsetWidth; st.classList.add('shake'); } }
  else sfx.lose();
}
// Écran plein « Gros gain / Énorme gain / Jackpot » avec rayons, compteur et pluie de pièces.
const bw = $('#bigwin'); let bwT = 0;
function bigWin(mult, amount, cx, cy) {
  const level = mult >= 50 ? 3 : mult >= 15 ? 2 : 1;
  $('#bwKicker').textContent = ['Gros gain !', 'Énorme gain !', 'Jackpot !'][level - 1];
  $('#bwMult').textContent = fmtX(mult);
  bw.className = 'bigwin lvl' + level; bw.hidden = false;
  countTo($('#bwAmount'), 0, amount || 0, 1400 + level * 400, money);
  sfx.fanfare(level); music.duck(3 + level);
  burst(cx, cy, 30, { confetti: 80 * level });
  setTimeout(() => burst(0, 0, 40 * level, { rain: true }), 250);
  clearTimeout(bwT); bwT = setTimeout(closeBigWin, 2600 + level * 900);
}
function closeBigWin() { clearTimeout(bwT); if (bw.hidden) return; bw.classList.add('out'); setTimeout(() => { bw.hidden = true; bw.classList.remove('out'); }, 300); }
bw.addEventListener('click', closeBigWin);
function flyCoins(fromEl, toEl, n = 10) {
  if (reduce) return;
  const a = fromEl.getBoundingClientRect(), b = toEl.getBoundingClientRect();
  const x0 = a.left + a.width / 2 - 12, y0 = a.top + a.height / 2 - 12, x1 = b.left + 14, y1 = b.top + b.height / 2 - 12;
  for (let i = 0; i < n; i++) {
    const c = h('<svg class="fly" aria-hidden="true"><use href="#i-coin"/></svg>'); document.body.appendChild(c);
    const mx = (x0 + x1) / 2 + rand(-90, 90), my = Math.min(y0, y1) - rand(40, 140);
    c.animate([
      { transform: `translate(${x0}px,${y0}px) scale(.6)`, opacity: 0 },
      { transform: `translate(${mx}px,${my}px) scale(1.1)`, opacity: 1, offset: .5 },
      { transform: `translate(${x1}px,${y1}px) scale(.7)`, opacity: .9 }
    ], { duration: 700, delay: i * 45, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'both' }).finished.then(() => c.remove());
  }
}

/* ---------- Fond animé ---------- */
// Poussière d'or qui flotte et scintille derrière l'interface (léger : ~30 images/s, peu de particules).
(function ambient() {
  const cv = $('#amb'), ctx = cv.getContext('2d'); let W = 0, H = 0, dots = [], last = 0;
  function fit() {
    const d = Math.min(devicePixelRatio || 1, 1.5); W = innerWidth; H = innerHeight;
    cv.width = W * d; cv.height = H * d; ctx.setTransform(d, 0, 0, d, 0, 0);
    const n = Math.round(Math.min(46, W * H / 22000));
    dots = Array.from({ length: n }, () => ({ x: rand(0, W), y: rand(0, H), r: rand(.6, 2.2), v: rand(.08, .35), ph: rand(0, 6.28), sw: rand(.2, .8) }));
    if (reduce) draw(0);
  }
  function draw(now) {
    ctx.clearRect(0, 0, W, H);
    const rgb = document.documentElement.dataset.theme === 'light' ? '176,128,30' : '246,221,147';
    for (const p of dots) {
      if (!reduce) { p.y -= p.v; p.x += Math.sin(now / 2400 + p.ph) * p.sw * .3; if (p.y < -6) { p.y = H + 6; p.x = rand(0, W); } }
      const a = .25 + .55 * (.5 + .5 * Math.sin(now / 700 + p.ph * 3));
      ctx.fillStyle = `rgba(${rgb},${(a * .7).toFixed(3)})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283); ctx.fill();
      if (p.r > 1.8 && a > .7) { ctx.fillStyle = `rgba(${rgb},${((a - .7) * .5).toFixed(3)})`; ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 3.5, 0, 6.283); ctx.fill(); }
    }
  }
  function loop(now) { if (!document.hidden && now - last > 33) { last = now; draw(now); } requestAnimationFrame(loop); }
  addEventListener('resize', fit); fit();
  if (!reduce) requestAnimationFrame(loop);
})();

/* ---------- Thème ---------- */
const themeBtn = $('#themeBtn');
function applyTheme(t) {
  const light = t === 'light'; document.documentElement.dataset.theme = light ? 'light' : 'dark';
  $('meta[name="theme-color"]').content = light ? '#e9efe9' : '#050e0f';
  $('use', themeBtn).setAttribute('href', light ? '#i-moon' : '#i-sun');
  themeBtn.setAttribute('aria-label', light ? 'Passer au thème sombre' : 'Passer au thème clair');
  $('#thmSwitch').setAttribute('aria-checked', String(!light));
}
function toggleTheme() {
  const t = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  pref.set('theme', t); applyTheme(t); sfx.star();
}
themeBtn.addEventListener('click', toggleTheme);
$('#thmSwitch').addEventListener('click', toggleTheme);
applyTheme(pref.get('theme', 'dark'));

/* ================= Portefeuille ================= */
const balBtn = $('#balBtn'), balTxt = $('#balTxt'), pop = $('#balPop');
let shownBal = 0, held = 0;
function countTo(el, from, to, ms, f) {
  el._tok = (el._tok || 0) + 1; const tok = el._tok, t0 = performance.now();
  if (reduce || from === to) { el.textContent = f(to); return; }
  (function fr(now) {
    if (tok !== el._tok) return;
    const p = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - p, 3);
    el.textContent = f(from + (to - from) * e);
    if (p < 1) requestAnimationFrame(fr);
  })(t0);
}
// Solde affiché : solde réel moins les gains dont l'animation n'est pas encore terminée.
const shown = () => r2(S.balance - held);
function renderBalance(flash) {
  const v = shown(); countTo(balTxt, shownBal, v, 650, money); shownBal = v;
  if (flash) { balBtn.classList.remove('up', 'down'); void balBtn.offsetWidth; balBtn.classList.add(flash); }
  renderPlayer(); if (!pop.hidden) renderPop();
}
const W = {
  can(amount) {
    amount = r2(amount);
    if (!(amount > 0)) { toast('Indiquez une mise valide.', 'err'); return false; }
    if (amount < .1) { toast('La mise minimale est de 0,10 jeton.', 'err'); return false; }
    if (amount > shown() + 1e-9) { toast('Solde insuffisant. Touchez + pour ajouter des jetons.', 'err'); renderBalance('down'); sfx.lose(); return false; }
    return true;
  },
  // Reçoit le portefeuille du serveur ; « hold » met de côté un gain à révéler plus tard.
  sync(w, hold = 0) { if (!w) return; S.balance = w.balance; S.stats = w.stats; held = r2(held + hold); renderBalance(); },
  hold(r) { W.sync(r.wallet, r.payout || 0); },
  // Fin d'animation : révèle le gain et l'inscrit dans l'historique.
  done(game, r) {
    held = Math.max(0, r2(held - (r.payout || 0)));
    S.hist.unshift({ g: game, net: r.net, t: Date.now() }); S.hist = S.hist.slice(0, 30);
    renderBalance(r.net > 0 ? 'up' : null);
  },
  settle(game, r) { W.hold(r); W.done(game, r); }
};

/* ================= Joueur, popup, dialogues ================= */
function renderPlayer() {
  $('#pname').textContent = S.name; $('#avatar').textContent = (S.name.trim()[0] || 'J').toUpperCase();
  $('#plevel').textContent = 'Niveau ' + (Math.floor(Math.sqrt(S.stats.played / 2)) + 1);
  const hr = new Date().getHours();
  $('#hello').textContent = `${hr < 5 ? 'Bonne nuit' : hr < 18 ? 'Bonjour' : 'Bonsoir'}, ${S.name}`;
}
const GNAME = { slots: 'Bandit d’Or', roulette: 'Roulette', bj: 'Blackjack', crash: 'Fusée', mines: 'Mines', plinko: 'Plinko', dice: 'Dés', coin: 'Pile ou face', depot: 'Dépôt de jetons', reset: 'Remise à zéro' };
function ago(t) { const s = (Date.now() - t) / 1000; if (s < 60) return 'à l’instant'; if (s < 3600) return `il y a ${Math.floor(s / 60)} min`; if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`; return `il y a ${Math.floor(s / 86400)} j`; }
function renderPop() {
  $('#popBal').textContent = money(shown());
  const net = r2(S.stats.won - S.stats.wagered), ne = $('#stNet');
  ne.textContent = (net > 0 ? '+' : '') + money(net); ne.className = net > 0 ? 'pos' : net < 0 ? 'neg' : '';
  $('#stBest').textContent = money(S.stats.best); $('#stWag').textContent = money(S.stats.wagered);
  $('#stPlayed').textContent = S.stats.played.toLocaleString('fr-FR');
  const ul = $('#histList'); ul.innerHTML = '';
  if (!S.hist.length) ul.innerHTML = '<li><span class="muted">Aucune partie pour l’instant.</span></li>';
  S.hist.slice(0, 5).forEach(e => {
    const li = h(`<li><span><span></span><span class="t"></span></span><b></b></li>`);
    li.children[0].children[0].textContent = GNAME[e.g] || e.g; li.children[0].children[1].textContent = ago(e.t);
    const b = li.children[1]; b.textContent = (e.net > 0 ? '+' : '') + money(e.net); b.className = e.net > 0 ? 'pos' : e.net < 0 ? 'neg' : 'muted';
    ul.appendChild(li);
  });
  $('#sndSwitch').setAttribute('aria-checked', String(S.sound));
  $('#musSwitch').setAttribute('aria-checked', String(music.on));
  $('#acctLine').textContent = S.guest ? 'Partie invitée : vos jetons restent sur cet appareil.' : `Connecté en tant que ${S.username}.`;
  $('#popUpgrade').hidden = !S.guest;
}
function openPop() {
  renderPop(); pop.hidden = false; balBtn.setAttribute('aria-expanded', 'true'); sfx.click();
  api('/me').then(p => { S.hist = p.hist; if (!held) W.sync(p.wallet); else renderPop(); }).catch(() => {});
}
function closePop() { pop.hidden = true; balBtn.setAttribute('aria-expanded', 'false'); resetArm(false); }
balBtn.addEventListener('click', () => pop.hidden ? openPop() : closePop());
document.addEventListener('pointerdown', e => { if (!pop.hidden && !pop.contains(e.target) && !balBtn.contains(e.target)) closePop(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !pop.hidden) { closePop(); balBtn.focus(); } });
$('#sndSwitch').addEventListener('click', () => { S.sound = !S.sound; save(); audio(); renderPop(); sfx.click(); });
$('#musSwitch').addEventListener('click', () => { music.toggle(); renderPop(); sfx.click(); });
let armed = false, armT;
function resetArm(on) { armed = on; clearTimeout(armT); $('#popReset').textContent = on ? 'Confirmer' : 'Réinitialiser'; if (on) armT = setTimeout(() => resetArm(false), 3000); }
$('#popReset').addEventListener('click', async () => {
  if (!armed) return resetArm(true);
  resetArm(false);
  const r = await play('/wallet/reset', {}); if (!r) return;
  held = 0; S.hist = r.hist; W.sync(r.wallet); renderBalance('up'); toast('Solde remis à 1 000 jetons.');
  if (curGame) route(); // les parties en cours ont été annulées
});

const depDlg = $('#depDlg'); let depAmt = 1000;
function openDeposit() { closePop(); depDlg.showModal(); sfx.click(); }
$('#plusBtn').addEventListener('click', openDeposit);
$('#popAdd').addEventListener('click', openDeposit);
$('#depGrid').addEventListener('click', e => {
  const b = e.target.closest('.dep-opt'); if (!b) return; depAmt = +b.dataset.amt; sfx.click();
  $$('.dep-opt').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  $('#depGo').textContent = `Ajouter ${depAmt.toLocaleString('fr-FR')} jetons`;
});
$('#depGo').addEventListener('click', async () => {
  const go = $('#depGo'), amt = depAmt; go.disabled = true;
  const r = await play('/wallet/deposit', { amount: amt }); go.disabled = false; if (!r) return;
  flyCoins(go, balBtn, 12); depDlg.close();
  S.hist = r.hist; W.sync(r.wallet, amt);
  sfx.coin(); setTimeout(() => { held = Math.max(0, r2(held - amt)); renderBalance('up'); sfx.coin(); }, reduce ? 0 : 650);
  toast(`${amt.toLocaleString('fr-FR')} jetons ajoutés.`, 'win');
});
[depDlg, $('#nameDlg'), $('#boardDlg')].forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));
$('#playerBtn').addEventListener('click', () => { $('#nameInput').value = S.name; $('#nameDlg').showModal(); });
$('#nameForm').addEventListener('submit', e => {
  if (e.submitter && e.submitter.value === 'cancel') return;
  const v = $('#nameInput').value.trim(); if (v) { S.name = v.slice(0, 18); save(); renderPlayer(); toast('Nom enregistré.'); }
});

/* ---------- Classement ---------- */
$('#popBoard').addEventListener('click', async () => {
  closePop();
  const r = await play('/leaderboard'); if (!r) return;
  const ol = $('#boardList'); ol.innerHTML = '';
  if (!r.players.length) ol.innerHTML = '<li><span class="nm muted">Personne n’a encore joué.</span></li>';
  r.players.forEach(p => {
    const li = h('<li><span class="nm"></span><b></b></li>');
    $('.nm', li).textContent = p.name; $('b', li).textContent = money(p.balance);
    if (p.name === S.name) li.classList.add('me');
    ol.appendChild(li);
  });
  $('#boardDlg').showModal();
});

/* ---------- Connexion ---------- */
const authDlg = $('#authDlg'); let authMode = 'login', upgrading = false;
function setAuthMode(m) {
  authMode = m;
  $$('#authTabs button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.m === m)));
  $('#authNameField').hidden = m !== 'register';
  $('#authPass').autocomplete = m === 'register' ? 'new-password' : 'current-password';
  $('#authGo').textContent = m === 'register' ? (upgrading ? 'Créer mon compte' : 'Créer un compte et jouer') : 'Se connecter';
  $('#authErr').textContent = '';
}
function showAuth(upgrade = false) {
  upgrading = upgrade;
  $('#authTitle').textContent = upgrade ? 'Créer un compte' : 'Bienvenue';
  $('#authSub').textContent = upgrade ? 'Choisissez un identifiant et un mot de passe : vous gardez vos jetons et votre historique.' : 'Connectez-vous pour retrouver vos jetons, ou créez un compte : 1 000 jetons offerts.';
  $('#authTabs').hidden = upgrade; $('#authGuest').hidden = upgrade; $('#authCancel').hidden = !upgrade;
  setAuthMode(upgrade ? 'register' : 'login');
  $('#authPass').value = '';
  if (!authDlg.open) authDlg.showModal();
  $('#authUser').focus();
}
function needAuth() {
  if (!authed && authDlg.open) return;
  authed = false; if (unmount) { unmount(); unmount = null; }
  S = JSON.parse(JSON.stringify(DEFAULT)); held = 0; renderBalance(); closePop();
  route(); showAuth();
}
async function signedIn(p, welcome) {
  applyProfile(p); authed = true; authDlg.close(); renderGrid(false); route(); toast(welcome, 'win');
}
authDlg.addEventListener('cancel', e => { if (!authed) e.preventDefault(); });
$('#authTabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { setAuthMode(b.dataset.m); sfx.click(); } });
$('#authCancel').addEventListener('click', () => authDlg.close());
$('#authForm').addEventListener('submit', async e => {
  e.preventDefault();
  const go = $('#authGo'), err = $('#authErr'), username = $('#authUser').value.trim(), password = $('#authPass').value;
  if (!username || !password) { err.textContent = 'Indiquez un identifiant et un mot de passe.'; return; }
  go.disabled = true; err.textContent = '';
  try {
    const reg = authMode === 'register';
    const p = await api(reg ? '/auth/register' : '/auth/login', { username, password, name: $('#authName').value });
    await signedIn(p, reg ? (upgrading ? 'Compte créé, vos jetons sont à l’abri.' : `Bienvenue, ${p.user.name} ! 1 000 jetons offerts.`) : `Bon retour, ${p.user.name}.`);
  } catch (ex) { err.textContent = ex.message; }
  go.disabled = false;
});
$('#authGuest').addEventListener('click', async () => {
  try { await signedIn(await api('/auth/guest', {}), 'Bienvenue ! 1 000 jetons offerts.'); }
  catch (ex) { $('#authErr').textContent = ex.message; }
});
$('#popUpgrade').addEventListener('click', () => { closePop(); showAuth(true); });
$('#popLogout').addEventListener('click', async () => {
  closePop();
  if (S.guest && !confirm('Vous jouez en invité : en vous déconnectant, vous perdrez l’accès à ces jetons. Continuer ?')) return;
  await api('/auth/logout', {}).catch(() => {});
  session.set(''); needAuth();
});

/* ================= Contrôle de mise ================= */
function betBox(host, gid, def = 10) {
  const v0 = S.bets[gid] ?? def;
  host.innerHTML = `<div class="betbox"><label for="bet-${gid}">Mise</label><div class="bet-row">
    <button type="button" data-a="half" aria-label="Diviser la mise par deux">½</button>
    <input id="bet-${gid}" type="number" inputmode="decimal" min="0.1" step="any" value="${v0}">
    <button type="button" data-a="dbl" aria-label="Doubler la mise">×2</button>
    <button type="button" data-a="max">Max</button></div></div>`;
  const inp = $('input', host);
  const store = () => { S.bets[gid] = +inp.value || 0; save(); host.dispatchEvent(new Event('betchange')); };
  host.addEventListener('click', e => {
    const a = e.target.closest('button')?.dataset.a; if (!a) return;
    let v = +inp.value || 0;
    if (a === 'half') v = Math.max(.1, r2(v / 2));
    if (a === 'dbl') v = r2(Math.max(1, v) * 2);
    if (a === 'max') v = Math.floor(shown() * 100) / 100;
    inp.value = v; store(); sfx.click();
  });
  inp.addEventListener('input', store);
  return { get value() { return r2(Math.max(0, +inp.value || 0)); }, set disabled(b) { $$('button,input', host).forEach(x => x.disabled = b); } };
}
const spaceKey = fn => e => { if (e.code === 'Space' && !/INPUT|BUTTON|SUMMARY|A/.test(document.activeElement.tagName) && !document.querySelector('dialog[open]')) { e.preventDefault(); fn(); } };

/* ================= Jeu : Bandit d'Or ================= */
function gSlots(root) {
  const SY = [['cherry', 22], ['lemon', 22], ['bell', 16], ['gem', 12], ['bar', 8], ['seven', 4]], TOT = 84;
  // Tirage décoratif pour le défilement des rouleaux ; le résultat vient du serveur.
  const rnd = () => { let r = Math.random() * TOT; for (const [s, w] of SY) { if ((r -= w) < 0) return s; } return 'cherry'; };
  const r3 = () => [rnd(), rnd(), rnd()];
  const ic = id => `<svg viewBox="0 0 100 100" aria-hidden="true"><use href="#s-${id}"/></svg>`;
  const cell = id => `<div class="sl-cell">${ic(id)}</div>`;
  const rows = [['seven', 3, 100], ['bar', 3, 40], ['gem', 3, 25], ['bell', 3, 15], ['lemon', 3, 8], ['cherry', 3, 5], ['cherry', 2, 3]];
  root.innerHTML = `<div class="g-layout">
    <div class="g-stage st-slots">
      <div class="sl-window"><div class="sl-reels">${'<div class="sl-reel"><div class="sl-strip"></div></div>'.repeat(3)}</div><div class="sl-line"></div></div>
      <p class="g-msg" aria-live="polite">Alignez trois symboles sur la ligne centrale.</p>
    </div>
    <div class="g-panel"><div class="bb"></div><button class="btn-primary go">Lancer</button>
      <div><p class="plab">Table des gains, sur la ligne centrale</p><div class="paylist">${rows.map(([s, n, m]) => `<div class="pl-row"><span class="combo">${ic(s).repeat(n)}${n === 2 ? '<em>n’importe où</em>' : ''}</span><b>×${m}</b></div>`).join('')}</div></div>
    </div></div>`;
  const bet = betBox($('.bb', root), 'slots', 10);
  const reels = $$('.sl-reel', root), strips = reels.map(r => $('.sl-strip', r)), win = $('.sl-window', root), msg = $('.g-msg', root), go = $('.go', root);
  let cur = [r3(), r3(), r3()], busy = false, alive = true, pending = null;
  const set = (i, ids) => { strips[i].style.transform = 'none'; strips[i].innerHTML = ids.map(cell).join(''); };
  cur.forEach((c, i) => set(i, c));
  const unlock = () => { busy = false; go.disabled = false; bet.disabled = false; };
  async function spin() {
    if (busy) return; const b = bet.value; if (!W.can(b)) return;
    busy = true; go.disabled = true; bet.disabled = true;
    const r = await play('/games/slots/spin', { bet: b });
    if (!r) return unlock();
    W.hold(r); if (!alive) return W.done('slots', r);
    $$('.sl-cell.win', root).forEach(c => c.classList.remove('win')); win.classList.remove('hit');
    msg.textContent = 'Les rouleaux tournent…'; win.classList.add('spinning'); sfx.whoosh();
    const fin = r.reels, res = { m: r.mult, idx: r.idx }; pending = r;
    const H = $('.sl-cell', root).getBoundingClientRect().height, tk = setInterval(sfx.tick, 85);
    await Promise.all(reels.map(async (reel, i) => {
      const dur = reduce ? 300 + i * 150 : 1300 + i * 450, n = Math.round(dur / 1000 * 15) + 4;
      const ids = [...cur[i], ...Array.from({ length: n }, rnd), ...fin[i]]; set(i, ids);
      const end = -(ids.length - 3) * H;
      reel.classList.add('blur'); setTimeout(() => reel.classList.remove('blur'), dur * .8);
      const a = strips[i].animate([
        { transform: 'translateY(0)', easing: 'cubic-bezier(.4,0,.15,1)' },
        { transform: `translateY(${end - 10}px)`, offset: .9, easing: 'ease-out' },
        { transform: `translateY(${end}px)` }], { duration: dur, fill: 'forwards' });
      await a.finished; if (!alive) return; set(i, fin[i]); a.cancel(); sfx.stop();
    }));
    clearInterval(tk); if (!alive) return;
    win.classList.remove('spinning'); cur = fin; pending = null;
    W.done('slots', r);
    if (res.m) {
      res.idx.forEach(i => $$('.sl-cell', reels[i])[1].classList.add('win')); win.classList.add('hit');
      msg.textContent = `Gain : +${money(r.payout)} jetons`; celebrate(win, res.m, r.payout);
    } else { msg.textContent = ['Pas de gain. Un autre tour ?', 'Le prochain sera le bon.', 'Raté de peu.'][Math.floor(Math.random() * 3)]; defeat(win); }
    unlock();
  }
  go.onclick = spin;
  const key = spaceKey(spin); document.addEventListener('keydown', key);
  return () => { alive = false; document.removeEventListener('keydown', key); if (pending) W.done('slots', pending); };
}

/* ================= Jeu : Roulette ================= */
function gRoulette(root) {
  const ORDER = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
  const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
  const col = n => n === 0 ? 'green' : RED.has(n) ? 'red' : 'black';
  const OUT = [['d1', '1–12'], ['d2', '13–24'], ['d3', '25–36'], ['low', '1–18'], ['even', 'Pair'], ['red', 'Rouge'], ['black', 'Noir'], ['odd', 'Impair'], ['high', '19–36']];
  root.innerHTML = `<div class="g-layout wide">
    <div class="g-stage st-felt">
      <div class="rl-wheelwrap"><canvas class="rl-wheel" width="600" height="600" aria-hidden="true"></canvas><div class="rl-ballwrap"><span class="rl-ball"></span></div><span class="rl-pointer"></span></div>
      <p class="g-msg" aria-live="polite">Placez vos jetons sur le tapis, puis lancez la roue.</p>
      <div class="hist-row" aria-label="Derniers numéros"></div>
    </div>
    <div class="g-panel">
      <div><p class="plab">Valeur du jeton</p><div class="chips-sel">${[1, 5, 10, 25, 100].map(v => `<button class="cs" data-v="${v}" aria-pressed="${v === 10}">${v}</button>`).join('')}</div></div>
      <div class="rl-board">
        <button class="rl-cell green" data-b="n:0">0</button>
        <div class="rl-nums">${Array.from({ length: 36 }, (_, i) => i + 1).map(n => `<button class="rl-cell ${col(n)}" data-b="n:${n}">${n}</button>`).join('')}</div>
        <div class="rl-outs">${OUT.map(([k, l]) => `<button class="rl-out ${k === 'red' ? 'is-red' : k === 'black' ? 'is-black' : ''}" data-b="${k}">${l}</button>`).join('')}</div>
      </div>
      <div class="rl-total"><span class="muted">Mise totale</span><b class="tot">0,00</b></div>
      <div class="row2"><button class="btn clear">Effacer</button><button class="btn-primary go">Lancer la roue</button></div>
      <p class="plab" style="margin:0">Numéro plein ×36, douzaines ×3, chances simples ×2. Le zéro fait perdre les chances simples.</p>
    </div></div>`;
  const cv = $('.rl-wheel', root), ctx = cv.getContext('2d'), ballWrap = $('.rl-ballwrap', root), ball = $('.rl-ball', root);
  const msg = $('.g-msg', root), hist = $('.hist-row', root), go = $('.go', root), board = $('.rl-board', root);
  let chip = 10, bets = {}, rot = 0, busy = false, alive = true, pending = null;
  (function draw() {
    const Sz = 600, c = Sz / 2, R = c - 6, a = Math.PI * 2 / 37;
    const g = ctx.createRadialGradient(c, c, R * .8, c, c, R); g.addColorStop(0, '#8a6a22'); g.addColorStop(.5, '#f6dd93'); g.addColorStop(1, '#8a6a22');
    ctx.beginPath(); ctx.arc(c, c, R, 0, 7); ctx.fillStyle = g; ctx.fill();
    ORDER.forEach((n, k) => {
      const s = -Math.PI / 2 + k * a - a / 2;
      ctx.beginPath(); ctx.moveTo(c, c); ctx.arc(c, c, R * .9, s, s + a); ctx.closePath();
      ctx.fillStyle = n === 0 ? '#0e8a4f' : RED.has(n) ? '#c8213a' : '#161616'; ctx.fill();
      ctx.strokeStyle = 'rgba(246,221,147,.5)'; ctx.lineWidth = 2; ctx.stroke();
      ctx.save(); ctx.translate(c, c); ctx.rotate(k * a); ctx.fillStyle = '#fff'; ctx.font = `700 ${Sz * .042}px ${getComputedStyle(document.body).fontFamily}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(n, 0, -R * .8); ctx.restore();
    });
    const w = ctx.createRadialGradient(c, c, 0, c, c, R * .62); w.addColorStop(0, '#6b4424'); w.addColorStop(1, '#2e1b0d');
    ctx.beginPath(); ctx.arc(c, c, R * .62, 0, 7); ctx.fillStyle = w; ctx.fill(); ctx.strokeStyle = '#d4a84b'; ctx.lineWidth = 5; ctx.stroke();
    ctx.strokeStyle = '#d4a84b'; ctx.lineWidth = 7; ctx.lineCap = 'round';
    for (let i = 0; i < 4; i++) { ctx.beginPath(); const an = i * Math.PI / 2; ctx.moveTo(c + Math.cos(an) * R * .12, c + Math.sin(an) * R * .12); ctx.lineTo(c + Math.cos(an) * R * .4, c + Math.sin(an) * R * .4); ctx.stroke(); }
    ctx.beginPath(); ctx.arc(c, c, R * .12, 0, 7); ctx.fillStyle = '#f6dd93'; ctx.fill();
  })();
  const total = () => r2(Object.values(bets).reduce((a, b) => a + b, 0));
  function renderBets() {
    $$('[data-b]', board).forEach(b => { b.querySelector('.bb-badge')?.remove(); const v = bets[b.dataset.b]; if (v) b.appendChild(h(`<span class="bb-badge">${short(v)}</span>`)); });
    $('.tot', root).textContent = money(total());
  }
  const addHist = n => { hist.prepend(h(`<span class="hn ${col(n)}">${n}</span>`)); while (hist.children.length > 10) hist.lastChild.remove(); };
  api('/games/roulette/history').then(r => { if (alive) r.items.slice().reverse().forEach(d => addHist(d.n)); }).catch(() => {});
  $('.chips-sel', root).addEventListener('click', e => { const b = e.target.closest('.cs'); if (!b) return; chip = +b.dataset.v; $$('.cs', root).forEach(x => x.setAttribute('aria-pressed', String(x === b))); sfx.click(); });
  board.addEventListener('click', e => {
    const b = e.target.closest('[data-b]'); if (!b || busy) return;
    $$('.rl-cell.hit', root).forEach(x => x.classList.remove('hit'));
    bets[b.dataset.b] = r2((bets[b.dataset.b] || 0) + chip); renderBets(); sfx.click();
  });
  $('.clear', root).onclick = () => { if (busy) return; bets = {}; renderBets(); msg.textContent = 'Tapis vidé.'; };
  async function spin() {
    if (busy) return; const t = total();
    if (!t) { msg.textContent = 'Placez au moins un jeton sur le tapis.'; return; }
    if (!W.can(t)) return;
    const unlock = () => { busy = false; go.disabled = false; $$('button', board).forEach(b => b.disabled = false); };
    busy = true; go.disabled = true; $$('button', board).forEach(b => b.disabled = true); $$('.rl-cell.hit', root).forEach(x => x.classList.remove('hit'));
    const r = await play('/games/roulette/spin', { bets });
    if (!r) return unlock();
    W.hold(r); if (!alive) return W.done('roulette', r);
    msg.textContent = 'Les jeux sont faits, rien ne va plus…'; cv.parentElement.classList.add('spinning'); sfx.whoosh();
    const n = r.n, payout = r.payout;
    pending = r;
    const seg = 360 / 37, k = ORDER.indexOf(n), target = ((-k * seg) % 360 + 360) % 360, curMod = ((rot % 360) + 360) % 360;
    rot += ((target - curMod + 360) % 360) + 360 * 5;
    const dur = reduce ? 500 : 4800, ease = 'cubic-bezier(.12,.75,.2,1)';
    cv.style.transition = `transform ${dur}ms ${ease}`; cv.style.transform = `rotate(${rot}deg)`;
    ballWrap.getAnimations().forEach(a => a.cancel()); ball.getAnimations().forEach(a => a.cancel());
    ballWrap.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(-1440deg)' }], { duration: dur, easing: ease, fill: 'forwards' });
    ball.animate([{ transform: 'translateY(-250%)' }, { transform: 'translateY(-250%)', offset: .55 }, { transform: 'translateY(30%)', offset: .85 }, { transform: 'translateY(0)' }], { duration: dur, fill: 'forwards' });
    let gap = 60; const tick = async () => { while (busy && alive && gap < 420) { sfx.tick(); await sleep(gap); gap *= 1.07; } }; tick();
    await sleep(dur); if (!alive) return;
    busy = false; pending = null; cv.parentElement.classList.remove('spinning'); sfx.roll();
    W.done('roulette', r); const net = r.net;
    $(`[data-b="n:${n}"]`, board).classList.add('hit');
    addHist(n);
    const label = n === 0 ? 'Zéro' : `${n} ${RED.has(n) ? 'rouge' : 'noir'}`;
    if (payout > 0) { msg.textContent = `${label} : vous gagnez ${money(payout)} (${net >= 0 ? '+' : ''}${money(net)})`; if (net > 0) celebrate(cv, payout / t, payout); else sfx.coin(); }
    else { msg.textContent = `${label}. Pas de gain cette fois.`; defeat(cv); }
    go.disabled = false; $$('button', board).forEach(b => b.disabled = false);
  }
  go.onclick = spin;
  const key = spaceKey(spin); document.addEventListener('keydown', key);
  return () => { alive = false; document.removeEventListener('keydown', key); if (pending) W.done('roulette', pending); };
}

/* ================= Jeu : Blackjack ================= */
// Le sabot et les cartes sont gérés par le serveur ; la carte cachée de la banque n'est connue qu'à la fin de la main.
function gBJ(root) {
  root.innerHTML = `<div class="g-layout">
    <div class="g-stage st-felt bj">
      <div class="bj-side"><div class="bj-label">Banque <span class="total dt">0</span></div><div class="bj-hand dh"></div></div>
      <p class="bj-rule">La banque reste sur 17. Blackjack payé 3 pour 2.</p>
      <div class="bj-side"><div class="bj-hand ph"></div><div class="bj-label">Vous <span class="total pt">0</span></div></div>
      <p class="g-msg" aria-live="polite">Choisissez votre mise, puis distribuez.</p>
    </div>
    <div class="g-panel"><div class="bb"></div>
      <button class="btn-primary deal">Distribuer</button>
      <div class="bj-acts" hidden><button class="btn hit">Tirer</button><button class="btn stand">Rester</button><button class="btn dbl">Doubler</button></div>
    </div></div>`;
  const bet = betBox($('.bb', root), 'bj', 10);
  const ph = $('.ph', root), dh = $('.dh', root), pt = $('.pt', root), dt = $('.dt', root), msg = $('.g-msg', root), stage = $('.g-stage', root);
  const dealB = $('.deal', root), acts = $('.bj-acts', root), hitB = $('.hit', root), standB = $('.stand', root), dblB = $('.dbl', root);
  let P = [], D = [], stake = 0, phase = 'load', alive = true, hole = null, pendingEnd = null;
  const cv = r => r === 'A' ? 11 : ['J', 'Q', 'K'].includes(r) ? 10 : +r;
  const val = hd => { let t = 0, a = 0; for (const c of hd) { t += cv(c.r); if (c.r === 'A') a++; } while (t > 21 && a) { t -= 10; a--; } return t; };
  const faceHtml = c => `<span class="r">${c.r}</span><span class="s">${c.s}︎</span><span class="r2">${c.r}</span>`;
  function node(c) {
    const n = h(`<div class="pcard ${c ? '' : 'back'}"><div class="in"><div class="face"></div><div class="cback"></div></div></div>`);
    if (c) setFace(n, c); return n;
  }
  function setFace(n, c) { $('.face', n).innerHTML = faceHtml(c); n.classList.toggle('red', c.s === '♥' || c.s === '♦'); }
  function totals() { pt.textContent = P.length ? val(P) : 0; dt.textContent = D.length ? val(D) : 0; }
  async function give(hand, area, c, wait = true) {
    if (!alive) return; const n = node(c); area.appendChild(n);
    if (c) hand.push(c); else hole = n;
    sfx.card(); totals(); if (wait) await sleep(reduce ? 60 : 380);
  }
  async function reveal(c) {
    if (!hole || !alive) return; setFace(hole, c); D.push(c); hole.classList.remove('back'); hole = null;
    sfx.card(); totals(); await sleep(reduce ? 60 : 480);
  }
  function ui() {
    dealB.hidden = phase !== 'bet' && phase !== 'load'; dealB.disabled = phase === 'load';
    acts.hidden = phase === 'bet' || phase === 'deal' || phase === 'load'; bet.disabled = phase !== 'bet';
    [hitB, standB].forEach(b => b.disabled = phase !== 'play'); dblB.disabled = phase !== 'play' || P.length !== 2 || shown() < stake;
  }
  // Affiche les cartes reçues du serveur qui ne sont pas encore sur la table, puis termine la main si besoin.
  async function apply(r) {
    for (const c of r.player.slice(P.length)) await give(P, ph, c);
    if (!alive) return;
    if (!r.outcome) { phase = 'play'; ui(); msg.textContent = P.length === 2 ? 'Tirer, rester ou doubler ?' : 'Tirer ou rester ?'; return; }
    pendingEnd = r;
    if (hole) await reveal(r.dealer[1]);
    for (const c of r.dealer.slice(D.length)) await give(D, dh, c);
    end(r);
  }
  async function deal() {
    if (phase !== 'bet') return; const b = bet.value; if (!W.can(b)) return;
    phase = 'deal'; ui();
    const r = await play('/games/bj/deal', { bet: b });
    if (!r) { phase = 'bet'; return ui(); }
    W.hold(r); if (!alive) return r.outcome && W.done('bj', r);
    stake = r.stake; P = []; D = []; hole = null; ph.innerHTML = ''; dh.innerHTML = ''; msg.textContent = '';
    await give(P, ph, r.player[0]); await give(D, dh, r.dealer[0]); await give(P, ph, r.player[1]); await give(D, dh, null);
    if (!alive) return;
    await apply(r);
  }
  async function act(path) {
    if (phase !== 'play') return; phase = 'busy'; ui();
    const r = await play(path, {});
    if (!r) { phase = 'play'; return ui(); }
    W.hold(r); if (!alive) return r.outcome && W.done('bj', r);
    stake = r.stake; await apply(r);
  }
  function end(r) {
    if (!alive) return;
    pendingEnd = null; W.done('bj', r);
    msg.textContent = { win: `Gagné ! +${money(r.net)}`, bj: `Blackjack ! +${money(r.net)}`, push: 'Égalité, mise rendue.', lose: 'La banque gagne.', bust: 'Plus de 21, perdu.' }[r.outcome];
    if (r.payout > r.stake) celebrate(stage, r.payout / r.stake, r.payout); else if (r.outcome !== 'push') defeat(stage);
    stake = 0; phase = 'bet'; ui();
  }
  dealB.onclick = deal; hitB.onclick = () => act('/games/bj/hit'); standB.onclick = () => act('/games/bj/stand');
  dblB.onclick = () => { if (W.can(stake)) act('/games/bj/double'); };
  ui();
  // Reprend une main laissée en cours (la mise reste engagée sur le serveur).
  api('/games/bj/state').then(async r => {
    if (!alive) return;
    if (!r.active) { phase = 'bet'; return ui(); }
    stake = r.stake;
    for (const c of r.player) await give(P, ph, c, false);
    await give(D, dh, r.dealer[0], false); await give(D, dh, null, false);
    msg.textContent = 'Main en cours reprise.';
    phase = 'play'; ui();
  }).catch(() => { if (alive) { phase = 'bet'; ui(); } });
  return () => { alive = false; if (pendingEnd) W.done('bj', pendingEnd); };
}

/* ================= Jeu : Mines ================= */
// La position des mines reste sur le serveur jusqu'à la fin de la partie.
function gMines(root) {
  root.innerHTML = `<div class="g-layout">
    <div class="g-stage st-mines">
      <div class="mn-grid">${Array.from({ length: 25 }, (_, i) => `<button class="mn-tile" data-i="${i}" aria-label="Case ${i + 1}" disabled></button>`).join('')}</div>
      <p class="g-msg" aria-live="polite">Misez, puis trouvez les diamants en évitant les mines.</p>
    </div>
    <div class="g-panel"><div class="bb"></div>
      <div><p class="plab">Nombre de mines</p><div class="seg mcount">${[1, 3, 5, 10, 20].map(n => `<button data-n="${n}" aria-pressed="${n === 3}">${n}</button>`).join('')}</div></div>
      <div class="stats3"><div class="stat"><span>Actuel</span><b class="sm">×1,00</b></div><div class="stat"><span>Prochain</span><b class="sn">×1,00</b></div><div class="stat"><span>Gain</span><b class="sg">0,00</b></div></div>
      <button class="btn-primary go">Commencer</button>
    </div></div>`;
  const bet = betBox($('.bb', root), 'mines', 10);
  const grid = $('.mn-grid', root), tiles = $$('.mn-tile', root), msg = $('.g-msg', root), go = $('.go', root), seg = $('.mcount', root);
  let mines = 3, opened = 0, stake = 0, active = false, busy = true, alive = true;
  const mult = k => { if (!k) return 1; let m = 1; for (let i = 0; i < k; i++) m *= (25 - i) / (25 - mines - i); return Math.floor(m * .97 * 100) / 100; };
  const gemSvg = '<svg viewBox="0 0 100 100" aria-hidden="true"><use href="#s-gem"/></svg>', bombSvg = '<svg viewBox="0 0 100 100" aria-hidden="true"><use href="#i-bomb"/></svg>';
  function stats() {
    $('.sm', root).textContent = fmtX(mult(opened));
    $('.sn', root).textContent = opened < 25 - mines ? fmtX(mult(opened + 1)) : '–';
    $('.sg', root).textContent = money(active ? stake * mult(opened) : 0);
  }
  function ui() {
    go.classList.toggle('cash', active);
    go.textContent = active ? (opened ? `Encaisser ${money(stake * mult(opened))}` : 'Choisissez une case') : 'Commencer';
    go.disabled = busy || (active && !opened); bet.disabled = active || busy; $$('button', seg).forEach(b => b.disabled = active || busy);
    tiles.forEach(t => { if (!t.classList.contains('open')) t.disabled = !active || busy; });
    stats();
  }
  const pickCount = n => { mines = n; $$('button', seg).forEach(x => x.setAttribute('aria-pressed', String(+x.dataset.n === n))); };
  seg.addEventListener('click', e => { const b = e.target.closest('button'); if (!b || active) return; pickCount(+b.dataset.n); sfx.click(); stats(); });
  const openGem = i => { const t = tiles[i]; t.innerHTML = gemSvg; t.classList.add('open'); t.disabled = true; };
  async function start() {
    const b = bet.value; if (!W.can(b)) return;
    busy = true; ui();
    const r = await play('/games/mines/start', { bet: b, mines }); busy = false;
    if (!r) return ui();
    W.sync(r.wallet); if (!alive) return;
    stake = r.stake; active = true; opened = 0;
    tiles.forEach(t => { t.className = 'mn-tile'; t.innerHTML = ''; });
    msg.textContent = `${mines} mine${mines > 1 ? 's' : ''} cachée${mines > 1 ? 's' : ''}. Bonne chance !`; sfx.click(); ui();
  }
  function revealAll(set) { tiles.forEach((t, i) => { if (!t.classList.contains('open')) { t.innerHTML = set.has(i) ? bombSvg : gemSvg; t.classList.add('open', 'dim'); } t.disabled = true; }); }
  function finishCash(r) {
    active = false; W.settle('mines', r);
    revealAll(new Set(r.minePositions)); msg.textContent = `Encaissé à ${fmtX(r.mult)} : +${money(r.net)}`; celebrate(grid, r.mult, r.payout); ui();
  }
  async function cashout() {
    if (!active || !opened || busy) return;
    busy = true; ui();
    const r = await play('/games/mines/cashout', {}); busy = false;
    if (!r) return ui();
    if (!alive) return W.settle('mines', r);
    finishCash(r);
  }
  grid.addEventListener('click', async e => {
    const t = e.target.closest('.mn-tile'); if (!t || !active || busy || t.classList.contains('open')) return;
    const i = +t.dataset.i;
    busy = true; ui();
    const r = await play('/games/mines/reveal', { tile: i }); busy = false;
    if (!r) return ui();
    if (!alive) { if (!r.active) W.settle('mines', r); return; }
    if (r.boom) {
      active = false; t.innerHTML = bombSvg; t.classList.add('open', 'boom'); sfx.boom(); defeat(grid, true);
      if (navigator.vibrate) navigator.vibrate(120);
      grid.classList.remove('shake'); void grid.offsetWidth; grid.classList.add('shake');
      W.settle('mines', r); const set = new Set(r.minePositions); setTimeout(() => alive && revealAll(set), reduce ? 0 : 350);
      msg.textContent = 'Boum ! La mine emporte votre mise.'; ui(); return;
    }
    opened++; openGem(i); sfx.gem(opened);
    if (r.cashed) return finishCash(r);
    msg.textContent = `Diamant ! Multiplicateur ${fmtX(mult(opened))}`; ui();
  });
  go.onclick = () => active ? cashout() : start();
  ui();
  // Reprend une partie laissée en cours.
  api('/games/mines/state').then(r => {
    if (!alive) return; busy = false;
    if (r.active) {
      pickCount(r.mines); stake = r.stake; active = true; opened = r.opened.length; r.opened.forEach(openGem);
      msg.textContent = 'Partie en cours reprise.';
    }
    ui();
  }).catch(() => { if (alive) { busy = false; ui(); } });
  return () => { alive = false; };
}

/* ================= Jeu : Fusée (crash) ================= */
// Le point d'explosion est tiré et gardé secret par le serveur : le navigateur l'apprend quand la fusée explose
// (attente longue sur /crash/wait) ou au moment d'encaisser.
function gCrash(root) {
  root.innerHTML = `<div class="g-layout">
    <div class="g-stage st-night">
      <div class="cr-hist" aria-label="Derniers vols"></div>
      <div class="cr-box"><canvas class="cr-canvas" aria-hidden="true"></canvas><div class="cr-mult">×1,00</div></div>
      <p class="g-msg" aria-live="polite">Encaissez avant que la fusée n’explose.</p>
    </div>
    <div class="g-panel"><div class="bb"></div>
      <label class="field"><span>Encaissement automatique (facultatif)</span><input class="auto" type="number" inputmode="decimal" min="1.01" step="0.01" placeholder="Par exemple 2"></label>
      <button class="btn-primary go">Lancer la fusée</button>
    </div></div>`;
  const bet = betBox($('.bb', root), 'crash', 10);
  const stageEl = $('.g-stage', root), cv = $('.cr-canvas', root), ctx = cv.getContext('2d'), multEl = $('.cr-mult', root), msg = $('.g-msg', root), go = $('.go', root), autoInp = $('.auto', root), histEl = $('.cr-hist', root);
  const K = .00018, mAt = t => Math.exp(K * t);
  let phase = 'idle', t0 = 0, crashAt = 0, stake = 0, cashed = 0, cashing = false, autoAt = 0, cur = 1, raf = 0, alive = true, lastT = 0, round = 0, result = null;
  function fit() { const d = devicePixelRatio || 1, w = cv.clientWidth, hh = cv.clientHeight; if (cv.width !== Math.round(w * d) || cv.height !== Math.round(hh * d)) { cv.width = Math.round(w * d); cv.height = Math.round(hh * d); ctx.setTransform(d, 0, 0, d, 0, 0); } return [w, hh]; }
  function frame(t, m, boom) {
    const [w, hh] = fit(), pad = 28, xMax = Math.max(7000, t * 1.15), yMax = Math.max(2, m * 1.15);
    const X = s => pad + s / xMax * (w - pad * 1.6), Y = v => hh - pad - (v - 1) / (yMax - 1) * (hh - pad * 2);
    ctx.clearRect(0, 0, w, hh);
    ctx.font = '600 11px ' + getComputedStyle(document.body).fontFamily; ctx.fillStyle = 'rgba(255,255,255,.45)'; ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.lineWidth = 1;
    const step = yMax <= 3 ? .5 : yMax <= 6 ? 1 : yMax <= 20 ? 5 : Math.pow(10, Math.floor(Math.log10(yMax)));
    for (let v = 1; v <= yMax; v += step) { const y = Y(v); ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(w, y); ctx.stroke(); ctx.fillText(fmtX(v).replace(',00', ''), 2, y - 3); }
    if (t <= 0) { drawRocket(X(0), Y(1), -Math.PI / 4, boom); return; }
    const pts = []; for (let i = 0; i <= 60; i++) { const s = t * i / 60; pts.push([X(s), Y(mAt(s))]); }
    const grad = ctx.createLinearGradient(0, hh, 0, 0); grad.addColorStop(0, 'rgba(255,111,174,0)'); grad.addColorStop(1, boom ? 'rgba(255,90,110,.35)' : 'rgba(255,111,174,.35)');
    ctx.beginPath(); ctx.moveTo(pts[0][0], hh - pad); pts.forEach(p => ctx.lineTo(p[0], p[1])); ctx.lineTo(pts[60][0], hh - pad); ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
    ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.strokeStyle = boom ? '#ff6b79' : '#ff6fae'; ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.stroke();
    const [ax, ay] = pts[58], [bx, by] = pts[60];
    drawRocket(bx, by, Math.atan2(by - ay, bx - ax), boom);
  }
  function drawRocket(x, y, ang, boom) {
    if (boom) {
      [['#ffb547', 26], ['#ff6b79', 17], ['#fff3c0', 8]].forEach(([c, r]) => { ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fillStyle = c; ctx.fill(); });
      return;
    }
    ctx.save(); ctx.translate(x, y); ctx.rotate(ang + Math.PI / 4); ctx.font = '30px serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('🚀', 0, 0); ctx.restore();
  }
  function ui() {
    go.classList.toggle('cash', phase === 'run' && !cashed);
    go.disabled = phase === 'wait' || (phase === 'run' && (!!cashed || cashing));
    if (phase !== 'run') go.textContent = 'Lancer la fusée'; else if (cashed) go.textContent = `Encaissé à ${fmtX(cashed)}`;
    bet.disabled = phase === 'run' || phase === 'wait'; autoInp.disabled = phase === 'run' || phase === 'wait';
  }
  const addHist = m => { histEl.prepend(h(`<span class="hchip ${m >= 2 ? 'good' : 'bad'}">${fmtX(m)}</span>`)); while (histEl.children.length > 12) histEl.lastChild.remove(); };
  api('/games/crash/history').then(r => { if (alive) r.items.slice().reverse().forEach(d => addHist(d.crashAt)); }).catch(() => {});
  // Fin de manche connue (réponse d'encaissement ou de /wait) : on la note une seule fois.
  function learn(r) {
    if (result || !r || !alive) return;
    result = r; crashAt = r.crashAt; W.settle('crash', r);
    if (r.cashedAt > 0 && !cashed) { cashed = r.cashedAt; multEl.classList.add('cashed'); msg.textContent = `Encaissé à ${fmtX(cashed)} : +${money(r.net)}`; celebrate(cv, cashed, r.payout); ui(); }
  }
  function waitEnd(id) {
    (async () => {
      for (let tries = 0; alive && round === id && !result && tries < 20; tries++) {
        try { return learn(await api(`/games/crash/wait?round=${id}`)); }
        catch (e) { if (e.status && e.status !== 0) return; await sleep(1000); }
      }
    })();
  }
  function fly(id, elapsed = 0) {
    round = id; cashed = 0; cashing = false; crashAt = 0; result = null; cur = 1;
    phase = 'run'; t0 = performance.now() - elapsed; multEl.className = 'cr-mult'; ui();
    stageEl.classList.add('flying'); music.mood('tense');
    raf = requestAnimationFrame(loop); waitEnd(id);
  }
  async function launch() {
    if (phase !== 'idle' && phase !== 'done') return; const b = bet.value; if (!W.can(b)) return;
    const a = parseFloat(String(autoInp.value).replace(',', '.')); autoAt = a >= 1.01 ? a : 0;
    phase = 'wait'; ui();
    const r = await play('/games/crash/launch', { bet: b, auto: autoAt || null });
    if (!r) { phase = 'idle'; return ui(); }
    W.sync(r.wallet); if (!alive) return;
    stake = b; msg.textContent = 'Décollage !'; sfx.launch();
    fly(r.round);
  }
  function loop(now) {
    if (!alive) return; const t = now - t0; const m = mAt(t);
    if (crashAt && m >= crashAt) { lastT = Math.log(crashAt) / K; return crash(); }
    cur = m; lastT = t;
    if (autoAt && !cashed && !cashing && m >= autoAt) cashout();
    frame(t, m); multEl.textContent = fmtX(m);
    if (!cashed && !cashing) go.textContent = `Encaisser ${money(stake * m)}`;
    raf = requestAnimationFrame(loop);
  }
  async function cashout() {
    if (phase !== 'run' || cashed || cashing) return;
    cashing = true; ui(); go.textContent = 'Encaissement…';
    const r = await play('/games/crash/cashout', { round });
    cashing = false;
    if (r) learn(r); else waitEnd(round);
    if (alive) ui();
  }
  function crash() {
    phase = 'done'; cancelAnimationFrame(raf); frame(lastT, crashAt, true); multEl.textContent = fmtX(crashAt);
    stageEl.classList.remove('flying'); music.mood('game');
    if (!cashed) { multEl.classList.add('crashed'); msg.textContent = `La fusée a explosé à ${fmtX(crashAt)}.`; sfx.boom(); defeat(cv, true); }
    else msg.textContent += ` La fusée a explosé à ${fmtX(crashAt)}.`;
    addHist(crashAt); ui();
  }
  go.onclick = () => phase === 'run' ? cashout() : launch();
  const key = spaceKey(() => phase === 'run' ? cashout() : launch()); document.addEventListener('keydown', key);
  const ro = new ResizeObserver(() => { if (phase !== 'run') frame(phase === 'done' ? lastT : 0, phase === 'done' ? crashAt : 1, phase === 'done'); }); ro.observe(cv);
  frame(0, 1); ui();
  // Reprend un vol en cours (page rechargée en plein vol).
  api('/games/crash/state').then(r => {
    if (!alive || !r.active || phase !== 'idle') return;
    stake = r.stake; autoAt = r.autoAt || 0; if (autoAt) autoInp.value = autoAt;
    msg.textContent = 'Vol en cours repris.'; fly(r.round, r.elapsed);
  }).catch(() => {});
  return () => {
    alive = false; cancelAnimationFrame(raf); ro.disconnect(); document.removeEventListener('keydown', key); music.mood('lobby');
    if (phase === 'run' && !cashed && !result) {
      api('/games/crash/cashout', { round }, { keepalive: true }).then(r => {
        W.settle('crash', r);
        toast(r.cashedAt > 0 ? `Fusée encaissée automatiquement à ${fmtX(r.cashedAt)}.` : `La fusée a explosé à ${fmtX(r.crashAt)}.`);
      }).catch(() => api('/me').then(p => { S.hist = p.hist; W.sync(p.wallet); }).catch(() => {}));
    }
  };
}

/* ================= Jeu : Dés ================= */
function gDice(root) {
  root.innerHTML = `<div class="g-layout">
    <div class="g-stage st-dice">
      <div class="dc-result" aria-live="polite">50,00</div>
      <div class="dc-wrap"><div class="dc-marker"><span>0</span></div><input class="dc-range" type="range" min="2" max="98" step="1" value="50" aria-label="Seuil"></div>
      <div class="dc-scale"><span>0</span><span>25</span><span>50</span><span>75</span><span>100</span></div>
      <p class="g-msg" aria-live="polite">Réglez le seuil, puis lancez les dés.</p>
    </div>
    <div class="g-panel"><div class="bb"></div>
      <div class="seg mode"><button data-m="over" aria-pressed="true">Plus de</button><button data-m="under" aria-pressed="false">Moins de</button></div>
      <div class="stats3"><div class="stat"><span>Seuil</span><b class="sx">50</b></div><div class="stat"><span>Chance</span><b class="sc">50 %</b></div><div class="stat"><span>Gain</span><b class="sm">×1,98</b></div></div>
      <button class="btn-primary go">Lancer les dés</button>
    </div></div>`;
  const bet = betBox($('.bb', root), 'dice', 10);
  const range = $('.dc-range', root), marker = $('.dc-marker', root), res = $('.dc-result', root), msg = $('.g-msg', root), go = $('.go', root), seg = $('.mode', root);
  let mode = 'over', busy = false, alive = true, pending = null;
  const calc = () => { const x = +range.value, ch = mode === 'over' ? 100 - x : x; return { x, ch, m: Math.floor(99 / ch * 10000) / 10000 }; };
  function upd() {
    const { x, ch, m } = calc();
    range.style.setProperty('--g', mode === 'over' ? `linear-gradient(90deg,#ff6b79 0 ${x}%,#3ecf8e ${x}% 100%)` : `linear-gradient(90deg,#3ecf8e 0 ${x}%,#ff6b79 ${x}% 100%)`);
    $('.sx', root).textContent = (mode === 'over' ? '> ' : '< ') + x; $('.sc', root).textContent = ch + ' %'; $('.sm', root).textContent = fmtX(m);
  }
  range.addEventListener('input', () => { upd(); if (Math.random() < .5) sfx.tick(); });
  seg.addEventListener('click', e => { const b = e.target.closest('button'); if (!b || busy) return; mode = b.dataset.m; $$('button', seg).forEach(x => x.setAttribute('aria-pressed', String(x === b))); sfx.click(); upd(); });
  async function roll() {
    if (busy) return; const b = bet.value; if (!W.can(b)) return;
    const unlock = () => { busy = false; go.disabled = false; range.disabled = false; bet.disabled = false; };
    busy = true; go.disabled = true; range.disabled = true; bet.disabled = true;
    const { x } = calc(), out = await play('/games/dice/roll', { bet: b, target: x, mode });
    if (!out) return unlock();
    W.hold(out); if (!alive) return W.done('dice', out);
    const r = out.roll, win = out.win, m = out.mult;
    pending = out;
    res.className = 'dc-result rolling'; marker.className = 'dc-marker show'; sfx.roll();
    const t0 = performance.now(), dur = reduce ? 50 : 600;
    while (performance.now() - t0 < dur) { const v = Math.random() * 100; res.textContent = num(v); marker.style.left = v + '%'; sfx.tick(); await sleep(55); if (!alive) return; }
    res.textContent = num(r); marker.style.left = r + '%'; $('span', marker).textContent = num(r);
    res.classList.remove('rolling'); res.classList.add(win ? 'win' : 'lose'); marker.classList.add(win ? 'win' : 'lose');
    pending = null; W.done('dice', out);
    if (win) { msg.textContent = `${num(r)} : gagné, +${money(out.net)}`; celebrate(res, m, out.payout); }
    else { msg.textContent = `${num(r)} : perdu. Visez ${mode === 'over' ? 'au-dessus de' : 'en dessous de'} ${x}.`; defeat(res); }
    unlock();
  }
  go.onclick = roll; upd();
  const key = spaceKey(roll); document.addEventListener('keydown', key);
  return () => { alive = false; document.removeEventListener('keydown', key); if (pending) W.done('dice', pending); };
}

/* ================= Jeu : Pile ou face ================= */
function gCoin(root) {
  const M = 1.96;
  root.innerHTML = `<div class="g-layout">
    <div class="g-stage st-coin">
      <div class="cf-scene"><div class="cf-toss"><div class="cf-coin"><div class="cf-face">P</div><div class="cf-face tails">F</div></div></div></div>
      <div class="cf-shadow"></div>
      <p class="g-msg" aria-live="polite">Pile ou face ? Chaque bonne réponse paie ×1,96.</p>
      <div class="hist-row" aria-label="Derniers lancers"></div>
    </div>
    <div class="g-panel"><div class="bb"></div>
      <div class="seg pick"><button data-p="0" aria-pressed="true">Pile</button><button data-p="1" aria-pressed="false">Face</button></div>
      <div class="stats3"><div class="stat"><span>Gain</span><b>×1,96</b></div><div class="stat"><span>Série</span><b class="ss">0</b></div><div class="stat"><span>Potentiel</span><b class="sp">0,00</b></div></div>
      <button class="btn-primary go">Lancer la pièce</button>
    </div></div>`;
  const bbHost = $('.bb', root), bet = betBox(bbHost, 'coin', 10);
  const coin = $('.cf-coin', root), toss = $('.cf-toss', root), msg = $('.g-msg', root), go = $('.go', root), seg = $('.pick', root), hist = $('.hist-row', root);
  let pick = 0, face = 0, rot = 0, streak = 0, busy = false, alive = true, pending = null;
  const upd = () => { $('.sp', root).textContent = money(bet.value * M); $('.ss', root).textContent = streak; };
  bbHost.addEventListener('betchange', upd);
  const addHist = r => { hist.prepend(h(`<span class="hn ${r ? 'silver' : 'gold'}">${r ? 'F' : 'P'}</span>`)); while (hist.children.length > 12) hist.lastChild.remove(); };
  api('/games/coin/history').then(x => { if (alive) x.items.slice().reverse().forEach(d => addHist(d.r)); }).catch(() => {});
  seg.addEventListener('click', e => { const b = e.target.closest('button'); if (!b || busy) return; pick = +b.dataset.p; $$('button', seg).forEach(x => x.setAttribute('aria-pressed', String(x === b))); sfx.click(); });
  async function flip() {
    if (busy) return; const b = bet.value; if (!W.can(b)) return;
    const unlock = () => { busy = false; go.disabled = false; bet.disabled = false; $$('button', seg).forEach(x => x.disabled = false); };
    busy = true; go.disabled = true; bet.disabled = true; $$('button', seg).forEach(x => x.disabled = true);
    const out = await play('/games/coin/flip', { bet: b, pick });
    if (!out) return unlock();
    W.hold(out); if (!alive) return W.done('coin', out);
    const r = out.result, win = out.win; pending = out;
    rot += 1800 + (r !== face ? 180 : 0); face = r;
    coin.style.transform = `rotateY(${rot}deg)`; toss.classList.remove('up'); void toss.offsetWidth; toss.classList.add('up');
    msg.textContent = 'La pièce tourne…'; sfx.launch();
    await sleep(reduce ? 50 : 1650); if (!alive) return;
    pending = null; W.done('coin', out);
    addHist(r);
    if (win) { streak++; msg.textContent = `${r ? 'Face' : 'Pile'} ! Gagné, +${money(out.net)}${streak > 1 ? ` (série de ${streak})` : ''}`; celebrate(coin, M, out.payout); }
    else { streak = 0; msg.textContent = `${r ? 'Face' : 'Pile'}. Perdu cette fois.`; defeat(coin); }
    upd(); unlock();
  }
  go.onclick = flip; upd();
  const key = spaceKey(flip); document.addEventListener('keydown', key);
  return () => { alive = false; document.removeEventListener('keydown', key); if (pending) W.done('coin', pending); };
}

/* ================= Jeu : Plinko ================= */
function gPlinko(root) {
  const ROWS = 8, SETS = { low: [5.6, 2.1, 1.1, 1, .5, 1, 1.1, 2.1, 5.6], mid: [13, 3, 1.3, .7, .4, .7, 1.3, 3, 13], high: [29, 4, 1.5, .3, .2, .3, 1.5, 4, 29] };
  const COLS = ['#d12c45', '#e0533a', '#e8833a', '#e8b33a', '#f0d36a', '#e8b33a', '#e8833a', '#e0533a', '#d12c45'];
  root.innerHTML = `<div class="g-layout">
    <div class="g-stage st-plinko"><canvas class="pk" aria-hidden="true"></canvas><p class="g-msg" aria-live="polite">Lâchez une bille et visez les bords.</p></div>
    <div class="g-panel"><div class="bb"></div>
      <div><p class="plab">Niveau de risque</p><div class="seg risk"><button data-r="low" aria-pressed="true">Faible</button><button data-r="mid" aria-pressed="false">Moyen</button><button data-r="high" aria-pressed="false">Élevé</button></div></div>
      <button class="btn-primary go">Lâcher une bille</button>
      <p class="plab" style="margin:0">Vous pouvez lâcher plusieurs billes à la suite.</p>
    </div></div>`;
  const bet = betBox($('.bb', root), 'plinko', 5);
  const cv = $('.pk', root), ctx = cv.getContext('2d'), msg = $('.g-msg', root), go = $('.go', root), seg = $('.risk', root);
  let risk = 'low', balls = [], raf = 0, alive = true, flash = new Array(9).fill(-1e9), Wd = 300, Hd = 300, dx = 30, dy = 28, top = 30;
  function size() {
    const d = devicePixelRatio || 1; Wd = cv.clientWidth || 300; dx = Wd / 11; dy = dx * .92; top = dx * .9; Hd = top + ROWS * dy + dx * .9;
    cv.width = Math.round(Wd * d); cv.height = Math.round(Hd * d); cv.style.height = Hd + 'px'; ctx.setTransform(d, 0, 0, d, 0, 0);
  }
  const posAt = (r, k) => [Wd / 2 + (k - r / 2) * dx, top + r * dy - dx * .26];
  const slotX = k => Wd / 2 + (k - 4) * dx, slotY = () => top + (ROWS - 1) * dy + dy * .62;
  function draw(now) {
    ctx.clearRect(0, 0, Wd, Hd);
    ctx.fillStyle = '#e8f4f6';
    for (let r = 0; r < ROWS; r++) for (let j = 0; j < r + 3; j++) { ctx.beginPath(); ctx.arc(Wd / 2 + (j - (r + 2) / 2) * dx, top + r * dy, dx * .09, 0, 7); ctx.fill(); }
    const sy = slotY(), sw = dx * .9, sh = dx * .72;
    SETS[risk].forEach((m, k) => {
      const f = Math.max(0, 1 - (now - flash[k]) / 350), x = slotX(k) - sw / 2, y = sy + f * 5;
      ctx.fillStyle = COLS[k]; ctx.globalAlpha = .85 + f * .15;
      ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, sw, sh, 6) : ctx.rect(x, y, sw, sh); ctx.fill(); ctx.globalAlpha = 1;
      if (f > 0) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 * f; ctx.stroke(); }
      ctx.fillStyle = '#2a1206'; ctx.font = `800 ${Math.max(9, dx * .3)}px ${getComputedStyle(document.body).fontFamily}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(m).replace('.', ','), x + sw / 2, y + sh / 2);
    });
    for (const b of balls) {
      const el = Math.max(0, now - b.t0), i = Math.min(b.pts.length - 2, Math.floor(el / b.step)), f = Math.min(1, (el - i * b.step) / b.step);
      if (i > b.last) { b.last = i; if (i < b.pts.length - 1) sfx.peg(); }
      const [x0, y0] = b.pts[i], [x1, y1] = b.pts[i + 1], hop = i === 0 ? 0 : dy * .35;
      const x = x0 + (x1 - x0) * f, y = y0 + (y1 - y0) * f - hop * 4 * f * (1 - f);
      const g = ctx.createRadialGradient(x - 2, y - 2, 1, x, y, dx * .2); g.addColorStop(0, '#fff3c0'); g.addColorStop(1, '#c9962e');
      ctx.beginPath(); ctx.arc(x, y, dx * .17, 0, 7); ctx.fillStyle = g; ctx.fill();
      if (el >= b.step * (b.pts.length - 1)) b.done = true;
    }
    balls.filter(b => b.done).forEach(land);
    balls = balls.filter(b => !b.done);
  }
  function land(b) {
    flash[b.k] = performance.now();
    W.done('plinko', b.res); const net = b.res.net, m = b.res.mult;
    msg.textContent = `${fmtX(m)} : ${net >= 0 ? '+' : ''}${money(net)}`;
    if (m >= 3) celebrate(cv, m, b.res.payout); else if (m >= 1) { sfx.coin(); floatText(cv, '+' + money(b.res.payout)); } else { sfx.stop(); floatText(cv, '−' + money(-net), 'bad'); }
    if (!balls.some(x => !x.done) && !inflight) $$('button', seg).forEach(x => x.disabled = false);
  }
  function loop(now) { if (!alive) return; draw(now); raf = (balls.length || flash.some(f => now - f < 400)) ? requestAnimationFrame(loop) : 0; }
  let inflight = 0;
  async function drop() {
    const b = bet.value; if (!W.can(b)) return;
    inflight++; $$('button', seg).forEach(x => x.disabled = true); sfx.click();
    const res = await play('/games/plinko/drop', { bet: b, risk }); inflight--;
    if (!res) { if (!balls.length && !inflight) $$('button', seg).forEach(x => x.disabled = false); return; }
    W.hold(res); if (!alive) return W.done('plinko', res);
    let k = 0; const pts = [[Wd / 2, top - dy * 1.1]];
    for (let r = 0; r < ROWS; r++) { pts.push(posAt(r, k)); k += res.path[r]; }
    pts.push([slotX(k), slotY() + dx * .3]);
    balls.push({ pts, k, res, t0: performance.now(), step: reduce ? 30 : 125, last: 0, done: false });
    if (!raf) raf = requestAnimationFrame(loop);
  }
  seg.addEventListener('click', e => { const b = e.target.closest('button'); if (!b || balls.length || inflight) return; risk = b.dataset.r; $$('button', seg).forEach(x => x.setAttribute('aria-pressed', String(x === b))); sfx.click(); draw(performance.now()); });
  go.onclick = drop;
  const ro = new ResizeObserver(() => { if (balls.length) return; size(); draw(performance.now()); }); ro.observe(cv);
  size(); draw(performance.now());
  const key = spaceKey(drop); document.addEventListener('keydown', key);
  return () => { alive = false; cancelAnimationFrame(raf); ro.disconnect(); document.removeEventListener('keydown', key); balls.forEach(b => W.done('plinko', b.res)); balls = []; };
}

/* ================= Catalogue ================= */
const die = (n, cls = '') => { const on = { 1: [5], 2: [1, 9], 3: [1, 5, 9], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] }[n]; return `<span class="die ${cls}">${Array.from({ length: 9 }, (_, i) => `<i class="${on.includes(i + 1) ? 'on' : ''}"></i>`).join('')}</span>`; };
const plinkoArt = (() => { let s = ''; for (let r = 0; r < 5; r++) for (let j = 0; j < r + 3; j++) s += `<circle cx="${80 + (j - (r + 2) / 2) * 20}" cy="${22 + r * 17}" r="3.2" fill="#e8f4f6"/>`; return `<svg class="a-plinko" viewBox="0 0 160 120" aria-hidden="true">${s}<rect x="22" y="104" width="22" height="11" rx="3" fill="#d12c45"/><rect x="47" y="104" width="20" height="11" rx="3" fill="#e8833a"/><rect x="70" y="104" width="20" height="11" rx="3" fill="#f0d36a"/><rect x="93" y="104" width="20" height="11" rx="3" fill="#e8833a"/><rect x="116" y="104" width="22" height="11" rx="3" fill="#d12c45"/><circle cx="90" cy="47" r="6.5" fill="#e7bf5a" stroke="#8a6a22" stroke-width="1.5"/></svg>`; })();
const GAMES = [
  { id: 'slots', name: 'Bandit d’Or', cat: 'machines', tag: 'Machine à sous', max: '×100', c: ['#1a7d75', '#0a3d3b'], mount: gSlots,
    art: `<div class="a-slots"><span><svg viewBox="0 0 100 100"><use href="#s-seven"/></svg></span><span><svg viewBox="0 0 100 100"><use href="#s-seven"/></svg></span><span><svg viewBox="0 0 100 100"><use href="#s-seven"/></svg></span></div>` },
  { id: 'roulette', name: 'Roulette', cat: 'tables', tag: 'Européenne', max: '×36', badge: 'Populaire', c: ['#13704f', '#063525'], mount: gRoulette, art: `<div class="a-roul"></div>` },
  { id: 'bj', name: 'Blackjack', cat: 'tables', tag: 'Cartes', max: '×2,5', c: ['#7a1830', '#3a0a14'], mount: gBJ,
    art: `<div class="a-bj"><span class="pc">A<b>♠&#xFE0E;</b></span><span class="pc">K<b>♥&#xFE0E;</b></span></div>` },
  { id: 'crash', name: 'Fusée', cat: 'instant', tag: 'Crash', max: '×500', badge: 'Nouveau', c: ['#4a1670', '#140a28'], mount: gCrash,
    art: `<svg class="a-crash" viewBox="0 0 160 110" aria-hidden="true"><path d="M10 100 C60 98 100 82 128 34 L128 100Z" fill="rgba(255,111,174,.2)"/><path d="M10 100 C60 98 100 82 128 34" stroke="#ff6fae" stroke-width="4" fill="none" stroke-linecap="round"/><text x="134" y="30" font-size="24" text-anchor="middle" dominant-baseline="middle">🚀</text><text x="14" y="38" font-family="-apple-system,Segoe UI,Roboto,sans-serif" font-weight="800" font-size="24" fill="#fff">×2,45</text></svg>` },
  { id: 'mines', name: 'Mines', cat: 'instant', tag: 'Diamants', max: '×50 000', c: ['#3a3f7a', '#151838'], mount: gMines,
    art: `<div class="a-mines">${[0, 1, 0, 0, 1, 2, 1, 0, 0].map(t => `<i class="${t ? 'o' : ''}">${t === 1 ? '<svg viewBox="0 0 100 100"><use href="#s-gem"/></svg>' : t === 2 ? '<svg viewBox="0 0 100 100"><use href="#i-bomb"/></svg>' : ''}</i>`).join('')}</div>` },
  { id: 'plinko', name: 'Plinko', cat: 'instant', tag: 'Billes', max: '×29', c: ['#13788f', '#06303b'], mount: gPlinko, art: plinkoArt },
  { id: 'dice', name: 'Dés', cat: 'instant', tag: 'Plus ou moins', max: '×49,5', c: ['#a8661a', '#4a2a08'], mount: gDice, art: `<div class="a-dice">${die(5)}${die(3)}</div>` },
  { id: 'coin', name: 'Pile ou face', cat: 'instant', tag: 'Une chance sur deux', max: '×1,96', c: ['#3d4f5c', '#141c22'], mount: gCoin, art: `<div class="a-coin">P</div>` }
];

/* ================= Accueil ================= */
const grid = $('#grid'), cards = {};
let filter = 'all';
const isFav = id => S.favs.includes(id);
GAMES.forEach(g => {
  const c = h(`<article class="card" data-id="${g.id}">
    <a class="card-hit" href="#/jeu/${g.id}" aria-label="Jouer à ${g.name}"></a>
    <div class="art" style="--c1:${g.c[0]};--c2:${g.c[1]}" aria-hidden="true">${g.art}${g.badge ? `<span class="tag-badge">${g.badge}</span>` : ''}</div>
    <div class="meta"><h3>${g.name}</h3><p><span>${g.tag}</span><span class="mx">${g.max}</span></p></div>
    <button class="star" aria-pressed="false" aria-label="Ajouter ${g.name} aux favoris"><svg aria-hidden="true"><use href="#i-star"/></svg></button>
  </article>`);
  $('.star', c).addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); toggleFav(g.id, e.currentTarget); });
  cards[g.id] = c;
});
function toggleFav(id, btn) {
  const on = !isFav(id);
  S.favs = on ? [...S.favs, id] : S.favs.filter(x => x !== id); save();
  if (btn) { btn.classList.remove('pop'); void btn.offsetWidth; btn.classList.add('pop'); }
  on ? sfx.star() : sfx.click();
  const g = GAMES.find(x => x.id === id); toast(on ? `${g.name} épinglé en haut de l’accueil.` : `${g.name} retiré des favoris.`);
  renderGrid(true); syncGvStar();
}
function renderGrid(animate) {
  const first = new Map();
  if (animate && !reduce) Object.values(cards).forEach(c => { if (!c.hidden) first.set(c, c.getBoundingClientRect()); });
  const order = GAMES.slice().sort((a, b) => (isFav(b.id) - isFav(a.id)) || (S.favs.indexOf(a.id) - S.favs.indexOf(b.id)) || (GAMES.indexOf(a) - GAMES.indexOf(b)));
  $('.empty', grid)?.remove();
  let shown = 0;
  order.forEach(g => {
    const c = cards[g.id], fav = isFav(g.id), st = $('.star', c);
    c.classList.toggle('is-fav', fav); st.setAttribute('aria-pressed', String(fav));
    st.setAttribute('aria-label', `${fav ? 'Retirer' : 'Ajouter'} ${g.name} ${fav ? 'des' : 'aux'} favoris`);
    c.hidden = !(filter === 'all' || (filter === 'fav' ? fav : g.cat === filter)); if (!c.hidden) shown++;
    grid.appendChild(c);
  });
  if (!shown) grid.appendChild(h('<p class="empty">Aucun favori pour l’instant. Touchez l’étoile d’un jeu pour l’épingler ici.</p>'));
  const n = S.favs.length;
  $('#pinNote').innerHTML = `<svg aria-hidden="true"><use href="#i-star"/></svg><span></span>`;
  $('#pinNote span').textContent = n ? `${n} favori${n > 1 ? 's' : ''} épinglé${n > 1 ? 's' : ''} en haut de la liste.` : 'Touchez l’étoile d’un jeu pour l’épingler en haut.';
  if (first.size) Object.values(cards).forEach(c => {
    const f = first.get(c); if (!f || c.hidden) return; const l = c.getBoundingClientRect(), x = f.left - l.left, y = f.top - l.top;
    if (x || y) c.animate([{ transform: `translate(${x}px,${y}px)` }, { transform: 'none' }], { duration: 480, easing: 'cubic-bezier(.2,.8,.2,1)' });
  });
}
$('#filters').addEventListener('click', e => {
  const b = e.target.closest('.chipf'); if (!b) return; filter = b.dataset.f; sfx.click();
  $$('.chipf').forEach(x => x.setAttribute('aria-pressed', String(x === b))); renderGrid(false);
});

/* ================= Navigation ================= */
let unmount = null, curGame = null;
const gvStar = $('#gvStar');
function syncGvStar() { if (!curGame) return; const f = isFav(curGame.id); gvStar.setAttribute('aria-pressed', String(f)); gvStar.setAttribute('aria-label', f ? 'Retirer des favoris' : 'Ajouter aux favoris'); }
gvStar.addEventListener('click', () => curGame && toggleFav(curGame.id, gvStar));
function route() {
  if (unmount) { unmount(); unmount = null; }
  closePop(); closeBigWin();
  const m = location.hash.match(/^#\/jeu\/(\w+)/), g = authed && m && GAMES.find(x => x.id === m[1]);
  const home = $('#homeView'), gv = $('#gameView');
  if (g) {
    curGame = g; home.hidden = true; gv.hidden = false; $('#gvTitle').textContent = g.name; syncGvStar();
    document.title = `${g.name}, Maison d’Or`; gv.classList.remove('view-enter'); void gv.offsetWidth; gv.classList.add('view-enter');
    const rootEl = $('#gameRoot'); rootEl.innerHTML = ''; unmount = g.mount(rootEl) || null; music.mood('game');
  } else {
    curGame = null; gv.hidden = true; home.hidden = false; $('#gameRoot').innerHTML = ''; document.title = 'Maison d’Or';
    home.classList.remove('view-enter'); void home.offsetWidth; home.classList.add('view-enter'); renderGrid(false); music.mood('lobby');
    if (!reduce) { grid.classList.add('deal'); setTimeout(() => grid.classList.remove('deal'), 1200); }
  }
  scrollTo(0, 0);
}
addEventListener('hashchange', route);

/* ================= Démarrage ================= */
(async () => {
  balTxt.textContent = money(0); renderPlayer(); renderGrid(false); route();
  try {
    const p = await api('/auth/session');
    if (!p.user) return showAuth();
    applyProfile(p); authed = true; renderGrid(false); route();
  } catch (e) { toast(e.message, 'err'); showAuth(); }
})();
})();
