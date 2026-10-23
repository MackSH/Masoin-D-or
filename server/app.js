'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { createCasino, HttpError, GAMES } = require('./casino');

const SESSION_DAYS = 30;
const COOKIE = 'md_sid';
const HEADER = 'x-md-session'; // même mécanisme que la fonction Edge Supabase

/* ---------- Mots de passe ---------- */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [algo, salt, key] = String(stored || '').split('$');
  if (algo !== 'scrypt' || !salt || !key) return false;
  const want = Buffer.from(key, 'hex'), got = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), want.length);
  return crypto.timingSafeEqual(want, got);
}

const cleanName = v => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 18);
const parseCookies = h => Object.fromEntries(String(h || '').split(';').map(p => p.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
// Jeton de session : en-tête X-MD-Session, ou cookie.
const sessionToken = req => req.get(HEADER) || parseCookies(req.headers.cookie)[COOKIE];
const sleep = ms => new Promise(r => setTimeout(r, ms));

function createApp(db, { now = () => Date.now(), secureCookies = false } = {}) {
  const casino = createCasino(db, { now });
  casino.crashSweep();
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '20kb' }));

  const st = {
    session: db.prepare('SELECT user_id FROM sessions WHERE token = ? AND expires_at > ?'),
    newSession: db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'),
    delSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
    purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    byName: db.prepare('SELECT * FROM users WHERE username = ?'),
    user: db.prepare('SELECT * FROM users WHERE id = ?'),
    newUser: db.prepare('INSERT INTO users (username, pass_hash, display_name, is_guest, created_at) VALUES (?, ?, ?, ?, ?)'),
    upgrade: db.prepare('UPDATE users SET username = ?, pass_hash = ?, display_name = ?, is_guest = 0 WHERE id = ?'),
    prefs: db.prepare('UPDATE users SET display_name = @name, sound = @sound, favs = @favs, bets = @bets WHERE id = @id')
  };
  st.purgeSessions.run(now());

  /* ---------- Sessions ---------- */
  function startSession(res, userId) {
    const token = crypto.randomBytes(32).toString('base64url'), t = now();
    st.newSession.run(token, userId, t, t + SESSION_DAYS * 864e5);
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: secureCookies, maxAge: SESSION_DAYS * 864e5, path: '/' });
    return token;
  }
  function auth(req, res, next) {
    const token = sessionToken(req);
    const row = token && st.session.get(token, now());
    if (!row) return next(new HttpError(401, 'Connectez-vous pour jouer.'));
    req.uid = row.user_id; req.token = token; next();
  }

  // Limite les tentatives de connexion ratées par adresse IP.
  const fails = new Map();
  function throttle(req) {
    const f = fails.get(req.ip);
    if (f && f.n >= 10 && now() - f.t < 15 * 60e3) throw new HttpError(429, 'Trop de tentatives. Réessayez dans quelques minutes.');
  }
  function failed(req) { const f = fails.get(req.ip); fails.set(req.ip, { n: f && now() - f.t < 15 * 60e3 ? f.n + 1 : 1, t: now() }); }

  function profile(uid) {
    const u = st.user.get(uid);
    if (!u) throw new HttpError(401, 'Session expirée.');
    return {
      user: { name: u.display_name, username: u.username, guest: !!u.is_guest, sound: !!u.sound, favs: JSON.parse(u.favs), bets: JSON.parse(u.bets) },
      wallet: casino.wallet(uid), hist: casino.history(uid)
    };
  }

  const api = express.Router();
  const wrap = fn => (req, res, next) => { try { const out = fn(req, res); if (out && typeof out.then === 'function') out.then(v => res.json(v), next); else res.json(out); } catch (e) { next(e); } };

  api.post('/auth/register', wrap((req, res) => {
    throttle(req);
    const { username, password } = req.body || {};
    const login = String(username || '').trim();
    if (!/^[\p{L}\p{N}_.-]{3,20}$/u.test(login)) throw new HttpError(400, 'Identifiant : 3 à 20 lettres, chiffres, « _ », « . » ou « - ».');
    if (typeof password !== 'string' || password.length < 6 || password.length > 200) throw new HttpError(400, 'Le mot de passe doit contenir au moins 6 caractères.');
    if (st.byName.get(login)) throw new HttpError(409, 'Cet identifiant est déjà pris.');
    const name = cleanName(req.body.name) || login.slice(0, 18);
    // Un invité connecté qui crée un compte garde son solde et son historique.
    const token = sessionToken(req), cur = token && st.session.get(token, now());
    const guest = cur && st.user.get(cur.user_id);
    if (guest && guest.is_guest) { st.upgrade.run(login, hashPassword(password), name, guest.id); return { ...profile(guest.id), token }; }
    const uid = Number(st.newUser.run(login, hashPassword(password), name, 0, now()).lastInsertRowid);
    return { ...profile(uid), token: startSession(res, uid) };
  }));

  api.post('/auth/login', wrap((req, res) => {
    throttle(req);
    const { username, password } = req.body || {};
    const u = st.byName.get(String(username || '').trim());
    if (!u || typeof password !== 'string' || !checkPassword(password, u.pass_hash)) { failed(req); throw new HttpError(401, 'Identifiant ou mot de passe incorrect.'); }
    return { ...profile(u.id), token: startSession(res, u.id) };
  }));

  api.post('/auth/guest', wrap((req, res) => {
    const uid = Number(st.newUser.run(null, null, 'Invité', 1, now()).lastInsertRowid);
    return { ...profile(uid), token: startSession(res, uid) };
  }));

  api.post('/auth/logout', (req, res) => {
    const token = sessionToken(req);
    if (token) st.delSession.run(token);
    res.clearCookie(COOKIE, { path: '/' }).json({ ok: true });
  });

  // Session courante sans erreur 401 : utilisé au chargement de la page.
  api.get('/auth/session', wrap(req => {
    const token = sessionToken(req), row = token && st.session.get(token, now());
    if (!row) return { user: null };
    casino.crashResolve(row.user_id);
    return profile(row.user_id);
  }));

  api.use(auth);

  api.get('/me', wrap(req => { casino.crashResolve(req.uid); return profile(req.uid); }));
  api.patch('/me', wrap(req => {
    const u = st.user.get(req.uid), b = req.body || {};
    const name = b.name !== undefined ? cleanName(b.name) || u.display_name : u.display_name;
    const sound = b.sound !== undefined ? (b.sound ? 1 : 0) : u.sound;
    let favs = u.favs, bets = u.bets;
    if (Array.isArray(b.favs)) favs = JSON.stringify([...new Set(b.favs.filter(g => GAMES.includes(g)))]);
    if (b.bets && typeof b.bets === 'object') {
      const clean = {};
      for (const g of GAMES) { const v = Number(b.bets[g]); if (Number.isFinite(v) && v >= 0 && v <= 1e9) clean[g] = Math.round(v * 100) / 100; }
      bets = JSON.stringify(clean);
    }
    st.prefs.run({ id: req.uid, name, sound, favs, bets });
    return profile(req.uid);
  }));

  api.post('/wallet/deposit', wrap(req => ({ wallet: casino.deposit(req.uid, (req.body || {}).amount), hist: casino.history(req.uid) })));
  api.post('/wallet/reset', wrap(req => ({ wallet: casino.reset(req.uid), hist: casino.history(req.uid) })));
  api.get('/leaderboard', wrap(() => ({ players: casino.leaderboard(10) })));
  api.get('/games/:game/history', wrap(req => {
    if (!GAMES.includes(req.params.game)) throw new HttpError(404, 'Jeu inconnu.');
    return { items: casino.gameHistory(req.uid, req.params.game, 12) };
  }));

  const body = req => req.body || {};
  api.post('/games/slots/spin', wrap(req => casino.slots(req.uid, body(req))));
  api.post('/games/roulette/spin', wrap(req => casino.roulette(req.uid, body(req))));
  api.post('/games/dice/roll', wrap(req => casino.dice(req.uid, body(req))));
  api.post('/games/coin/flip', wrap(req => casino.coin(req.uid, body(req))));
  api.post('/games/plinko/drop', wrap(req => casino.plinko(req.uid, body(req))));

  api.get('/games/mines/state', wrap(req => casino.minesState(req.uid)));
  api.post('/games/mines/start', wrap(req => casino.minesStart(req.uid, body(req))));
  api.post('/games/mines/reveal', wrap(req => casino.minesReveal(req.uid, body(req))));
  api.post('/games/mines/cashout', wrap(req => casino.minesCashout(req.uid)));

  api.get('/games/bj/state', wrap(req => casino.bjState(req.uid)));
  api.post('/games/bj/deal', wrap(req => casino.bjDeal(req.uid, body(req))));
  api.post('/games/bj/hit', wrap(req => casino.bjHit(req.uid)));
  api.post('/games/bj/stand', wrap(req => casino.bjStand(req.uid)));
  api.post('/games/bj/double', wrap(req => casino.bjDouble(req.uid)));

  api.get('/games/crash/state', wrap(req => { casino.crashResolve(req.uid); return casino.crashState(req.uid); }));
  api.post('/games/crash/launch', wrap(req => {
    const out = casino.crashLaunch(req.uid, body(req));
    // Règle la manche au moment de l'explosion, même si le joueur a fermé la page.
    const left = casino.crashRemaining(req.uid);
    if (left !== null) setTimeout(() => { try { casino.crashResolve(req.uid); } catch (e) {} }, left + 10).unref?.();
    return out;
  }));
  api.post('/games/crash/cashout', wrap(req => {
    // La manche a pu se terminer juste avant (explosion ou encaissement automatique) : on renvoie son résultat.
    const round = body(req).round;
    if (round && casino.crashRemaining(req.uid, round) === null) { const done = casino.crashResult(req.uid, round); if (done) return done; }
    return casino.crashCashout(req.uid);
  }));
  // Attente longue : répond quand la fusée explose, avec le point d'explosion.
  api.get('/games/crash/wait', wrap(async req => {
    const round = Number(req.query.round);
    if (!Number.isInteger(round)) throw new HttpError(400, 'Manche invalide.');
    let left;
    while ((left = casino.crashRemaining(req.uid, round)) !== null) { await sleep(Math.min(left + 10, 40e3)); casino.crashResolve(req.uid); }
    const out = casino.crashResult(req.uid, round);
    if (!out) throw new HttpError(404, 'Manche introuvable.');
    return out;
  }));

  app.use('/api', api);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Route inconnue.' }));
  // En local, le site parle à ce serveur plutôt qu'à la fonction Edge Supabase.
  app.get('/config.js', (req, res) => res.type('js').send("window.MD_CONFIG = { apiUrl: '/api' };\n"));
  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

  // Erreurs : message lisible pour le joueur, détail technique dans la console.
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Requête invalide.' });
    console.error(err);
    res.status(500).json({ error: 'Erreur du serveur. Réessayez.' });
  });

  return app;
}

module.exports = { createApp, hashPassword, checkPassword };
