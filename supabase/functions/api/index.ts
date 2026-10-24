// API du casino Maison d'Or, déployée en fonction Edge Supabase.
// URL : https://<projet>.supabase.co/functions/v1/api/<route>
// La session est un jeton envoyé dans l'en-tête « X-MD-Session » (le site est servi depuis un autre domaine).
import postgres from 'npm:postgres@3.4.5';
import { Buffer } from 'node:buffer';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { createCasino, GAMES, HttpError } from './casino.ts';

const SESSION_DAYS = 30;
const HEADER = 'x-md-session';
const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') || '*').split(',').map(s => s.trim());

const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, {
  prepare: false, max: 3, idle_timeout: 20,
  types: { bigint: { to: 20, from: [20], serialize: (x: number) => String(x), parse: (x: string) => Number(x) } }
});
const casino = createCasino(sql);
const now = () => Date.now();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/* ---------- Mots de passe ---------- */
function hashPassword(pw: string) {
  const salt = randomBytes(16);
  const key = scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
function checkPassword(pw: string, stored: string | null) {
  const [algo, salt, key] = String(stored || '').split('$');
  if (algo !== 'scrypt' || !salt || !key) return false;
  const want = Buffer.from(key, 'hex'), got = scryptSync(pw, Buffer.from(salt, 'hex'), want.length);
  return timingSafeEqual(want, got);
}
const cleanName = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 18);

/* ---------- Sessions ---------- */
async function startSession(userId: number) {
  const token = randomBytes(32).toString('base64url'), t = now();
  await sql`insert into casino.sessions (token, user_id, created_at, expires_at) values (${token}, ${userId}, ${t}, ${t + SESSION_DAYS * 864e5})`;
  return token;
}
async function sessionUser(req: Request): Promise<number | null> {
  const token = req.headers.get(HEADER);
  if (!token) return null;
  const [row] = await sql`select user_id from casino.sessions where token = ${token} and expires_at > ${now()}`;
  return row ? row.user_id : null;
}

// Limite les tentatives de connexion ratées par adresse IP.
const clientIp = (req: Request) => (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'inconnue';
async function throttle(req: Request) {
  const [f] = await sql`select n, t from casino.login_failures where ip = ${clientIp(req)}`;
  if (f && f.n >= 10 && now() - f.t < 15 * 60e3) throw new HttpError(429, 'Trop de tentatives. Réessayez dans quelques minutes.');
}
async function failed(req: Request) {
  const t = now();
  await sql`insert into casino.login_failures (ip, n, t) values (${clientIp(req)}, 1, ${t})
            on conflict (ip) do update set n = case when ${t} - casino.login_failures.t < ${15 * 60e3} then casino.login_failures.n + 1 else 1 end, t = ${t}`;
}

async function profile(uid: number) {
  const [u] = await sql`select * from casino.users where id = ${uid}`;
  if (!u) throw new HttpError(401, 'Session expirée.');
  return {
    user: { name: u.display_name, username: u.username, guest: u.is_guest, sound: u.sound, favs: u.favs, bets: u.bets },
    wallet: await casino.wallet(uid), hist: await casino.history(uid)
  };
}

/* ---------- Routes ---------- */
// deno-lint-ignore no-explicit-any
type Ctx = { req: Request; body: any; uid: number; query: URLSearchParams };
// deno-lint-ignore no-explicit-any
type Handler = (c: Ctx) => Promise<any>;
const routes: Record<string, Handler> = {};
const publicRoutes: Record<string, Handler> = {};

publicRoutes['POST /auth/register'] = async ({ req, body }) => {
  await throttle(req);
  const login = String(body.username || '').trim(), password = body.password;
  if (!/^[\p{L}\p{N}_.-]{3,20}$/u.test(login)) throw new HttpError(400, 'Identifiant : 3 à 20 lettres, chiffres, « _ », « . » ou « - ».');
  if (typeof password !== 'string' || password.length < 6 || password.length > 200) throw new HttpError(400, 'Le mot de passe doit contenir au moins 6 caractères.');
  const [taken] = await sql`select 1 from casino.users where lower(username) = lower(${login})`;
  if (taken) throw new HttpError(409, 'Cet identifiant est déjà pris.');
  const name = cleanName(body.name) || login.slice(0, 18);
  // Un invité connecté qui crée un compte garde son solde et son historique.
  const cur = await sessionUser(req);
  const [guest] = cur ? await sql`select id, is_guest from casino.users where id = ${cur}` : [];
  if (guest && guest.is_guest) {
    await sql`update casino.users set username = ${login}, pass_hash = ${hashPassword(password)}, display_name = ${name}, is_guest = false where id = ${guest.id}`;
    return { ...(await profile(guest.id)), token: req.headers.get(HEADER) };
  }
  const [u] = await sql`insert into casino.users (username, pass_hash, display_name, is_guest, created_at)
                        values (${login}, ${hashPassword(password)}, ${name}, false, ${now()}) returning id`;
  return { ...(await profile(u.id)), token: await startSession(u.id) };
};

publicRoutes['POST /auth/login'] = async ({ req, body }) => {
  await throttle(req);
  const [u] = await sql`select id, pass_hash from casino.users where lower(username) = lower(${String(body.username || '').trim()})`;
  if (!u || typeof body.password !== 'string' || !checkPassword(body.password, u.pass_hash)) { await failed(req); throw new HttpError(401, 'Identifiant ou mot de passe incorrect.'); }
  return { ...(await profile(u.id)), token: await startSession(u.id) };
};

publicRoutes['POST /auth/guest'] = async () => {
  const [u] = await sql`insert into casino.users (display_name, is_guest, created_at) values ('Invité', true, ${now()}) returning id`;
  return { ...(await profile(u.id)), token: await startSession(u.id) };
};

publicRoutes['POST /auth/logout'] = async ({ req }) => {
  const token = req.headers.get(HEADER);
  if (token) await sql`delete from casino.sessions where token = ${token}`;
  return { ok: true };
};

// Session courante sans erreur 401 : utilisé au chargement de la page.
publicRoutes['GET /auth/session'] = async ({ req }) => {
  const uid = await sessionUser(req);
  if (!uid) return { user: null };
  await casino.crashResolve(uid);
  return profile(uid);
};

routes['GET /me'] = async ({ uid }) => { await casino.crashResolve(uid); return profile(uid); };
routes['PATCH /me'] = async ({ uid, body }) => {
  const [u] = await sql`select * from casino.users where id = ${uid}`;
  const name = body.name !== undefined ? cleanName(body.name) || u.display_name : u.display_name;
  const sound = body.sound !== undefined ? !!body.sound : u.sound;
  let favs = u.favs, bets = u.bets;
  if (Array.isArray(body.favs)) favs = [...new Set(body.favs.filter((g: string) => GAMES.includes(g)))];
  if (body.bets && typeof body.bets === 'object') {
    const clean: Record<string, number> = {};
    for (const g of GAMES) { const v = Number(body.bets[g]); if (Number.isFinite(v) && v >= 0 && v <= 1e9) clean[g] = Math.round(v * 100) / 100; }
    bets = clean;
  }
  await sql`update casino.users set display_name = ${name}, sound = ${sound}, favs = ${sql.json(favs)}, bets = ${sql.json(bets)} where id = ${uid}`;
  return profile(uid);
};

routes['POST /wallet/deposit'] = async ({ uid, body }) => ({ wallet: await casino.deposit(uid, body.amount), hist: await casino.history(uid) });
routes['POST /wallet/reset'] = async ({ uid }) => ({ wallet: await casino.reset(uid), hist: await casino.history(uid) });
routes['GET /leaderboard'] = async () => ({ players: await casino.leaderboard(10) });

routes['POST /games/slots/spin'] = ({ uid, body }) => casino.slots(uid, body);
routes['POST /games/roulette/spin'] = ({ uid, body }) => casino.roulette(uid, body);
routes['POST /games/dice/roll'] = ({ uid, body }) => casino.dice(uid, body);
routes['POST /games/coin/flip'] = ({ uid, body }) => casino.coin(uid, body);
routes['POST /games/plinko/drop'] = ({ uid, body }) => casino.plinko(uid, body);
routes['POST /games/keno/play'] = ({ uid, body }) => casino.keno(uid, body);

routes['GET /games/mines/state'] = ({ uid }) => casino.minesState(uid);
routes['POST /games/mines/start'] = ({ uid, body }) => casino.minesStart(uid, body);
routes['POST /games/mines/reveal'] = ({ uid, body }) => casino.minesReveal(uid, body);
routes['POST /games/mines/cashout'] = ({ uid }) => casino.minesCashout(uid);

routes['GET /games/bj/state'] = ({ uid }) => casino.bjState(uid);
routes['POST /games/bj/deal'] = ({ uid, body }) => casino.bjDeal(uid, body);
routes['POST /games/bj/hit'] = ({ uid }) => casino.bjHit(uid);
routes['POST /games/bj/stand'] = ({ uid }) => casino.bjStand(uid);
routes['POST /games/bj/double'] = ({ uid }) => casino.bjDouble(uid);

routes['GET /games/crash/state'] = async ({ uid }) => { await casino.crashResolve(uid); return casino.crashState(uid); };
routes['POST /games/crash/launch'] = ({ uid, body }) => casino.crashLaunch(uid, body);
routes['POST /games/crash/cashout'] = async ({ uid, body }) => {
  // La manche a pu se terminer juste avant (explosion ou encaissement automatique) : on renvoie son résultat.
  if (body.round && (await casino.crashRemaining(uid, body.round)) === null) {
    const done = await casino.crashResult(uid, Number(body.round));
    if (done) return done;
  }
  return casino.crashCashout(uid);
};
// Attente longue : répond quand la fusée explose, avec le point d'explosion.
routes['GET /games/crash/wait'] = async ({ uid, query }) => {
  const round = Number(query.get('round'));
  if (!Number.isInteger(round)) throw new HttpError(400, 'Manche invalide.');
  let left;
  while ((left = await casino.crashRemaining(uid, round)) !== null) { await sleep(Math.min(left + 10, 40e3)); await casino.crashResolve(uid); }
  const out = await casino.crashResult(uid, round);
  if (!out) throw new HttpError(404, 'Manche introuvable.');
  return out;
};

function cors(req: Request) {
  const origin = req.headers.get('origin') || '';
  const allow = ALLOWED_ORIGINS.includes('*') ? '*' : ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow, 'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': `content-type, ${HEADER}, authorization, apikey, x-client-info`,
    'Access-Control-Max-Age': '86400'
  };
}

Deno.serve(async req => {
  const headers = { ...cors(req), 'Content-Type': 'application/json; charset=utf-8' };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers });
  try {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/(functions\/v1\/)?api(?=\/|$)/, '') || '/';
    let key = `${req.method} ${path}`;
    const hist = /^\/games\/(\w+)\/history$/.exec(path);
    if (req.method === 'GET' && hist) key = 'GET /games/:game/history';
    const pub = publicRoutes[key], priv = routes[key];
    if (!pub && !priv && key !== 'GET /games/:game/history') return json(404, { error: 'Route inconnue.' });

    let body = {};
    if (req.method === 'POST' || req.method === 'PATCH') {
      const text = await req.text();
      if (text.length > 20000) throw new HttpError(413, 'Requête trop volumineuse.');
      if (text) { try { body = JSON.parse(text) ?? {}; } catch { throw new HttpError(400, 'Requête invalide.'); } }
      if (typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Requête invalide.');
    }
    const ctx = { req, body, uid: 0, query: url.searchParams };
    if (pub) return json(200, await pub(ctx));
    const uid = await sessionUser(req);
    if (!uid) throw new HttpError(401, 'Connectez-vous pour jouer.');
    ctx.uid = uid;
    if (hist) {
      if (!GAMES.includes(hist[1])) throw new HttpError(404, 'Jeu inconnu.');
      return json(200, { items: await casino.gameHistory(uid, hist[1], 12) });
    }
    return json(200, await priv(ctx));
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message });
    console.error(e);
    return json(500, { error: 'Erreur du serveur. Réessayez.' });
  }
});
