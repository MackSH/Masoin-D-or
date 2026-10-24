// Logique du casino : portefeuille et jeux. Tout le hasard et tous les gains
// sont décidés ici, côté serveur ; le navigateur ne fait qu'animer le résultat.
// Chaque opération s'exécute dans une transaction Postgres qui verrouille la ligne du joueur.
import { randomBytes, randomInt } from 'node:crypto';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const bad = (msg: string) => new HttpError(400, msg);

/* ---------- Hasard ---------- */
const randInt = (n: number) => randomInt(n);                                       // entier dans [0, n)
const randFloat = () => randomBytes(6).readUIntBE(0, 6) / 2 ** 48;                 // réel dans [0, 1)
const shuffle = <T>(a: T[]) => { for (let i = a.length - 1; i > 0; i--) { const j = randInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };

/* ---------- Montants (centimes) ---------- */
export const START_BALANCE = 100000; // 1 000 jetons
const MIN_BET = 10; // 0,10 jeton
function toCents(x: unknown, what = 'mise') {
  const v = typeof x === 'string' ? Number(x.replace(',', '.')) : Number(x);
  if (!Number.isFinite(v) || v <= 0) throw bad(`Indiquez une ${what} valide.`);
  const c = Math.round(v * 100);
  if (c < MIN_BET) throw bad('La mise minimale est de 0,10 jeton.');
  if (c > 1e12) throw bad('Montant trop élevé.');
  return c;
}
const fromCents = (c: number) => c / 100;

/* ---------- Définitions des jeux ---------- */
export const GAMES = ['slots', 'roulette', 'bj', 'crash', 'mines', 'plinko', 'dice', 'coin', 'keno'];
const DEPOSITS = [500, 1000, 2500, 10000];

const SLOT_SYMBOLS: [string, number][] = [['cherry', 22], ['lemon', 22], ['bell', 16], ['gem', 12], ['bar', 8], ['seven', 4]];
const SLOT_TOTAL = SLOT_SYMBOLS.reduce((a, [, w]) => a + w, 0);
const SLOT_PAY: Record<string, number> = { seven: 100, bar: 40, gem: 25, bell: 15, lemon: 8, cherry: 5 };

const RL_RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const RL_OUTSIDE = ['d1', 'd2', 'd3', 'low', 'high', 'even', 'odd', 'red', 'black'];

const MINES_COUNTS = [1, 3, 5, 10, 20];
const minesMult = (mines: number, k: number) => { if (!k) return 1; let m = 1; for (let i = 0; i < k; i++) m *= (25 - i) / (25 - mines - i); return Math.floor(m * 0.97 * 100) / 100; };

const PLINKO_ROWS = 8;
const PLINKO_SETS: Record<string, number[]> = {
  low: [5.6, 2.1, 1.1, 1, 0.5, 1, 1.1, 2.1, 5.6],
  mid: [13, 3, 1.3, 0.7, 0.4, 0.7, 1.3, 3, 13],
  high: [29, 4, 1.5, 0.3, 0.2, 0.3, 1.5, 4, 29]
};

const COIN_MULT = 1.96;

// Keno : 40 numéros, 10 tirés, le joueur en choisit de 1 à 10.
// KENO_PAY[choix - 1][bons numéros] = multiplicateur (environ 97 % de retour pour chaque nombre de choix).
const KENO_POOL = 40, KENO_DRAW = 10;
const KENO_PAY = [
  [0, 3.88],
  [0, 1.86, 4.41],
  [0, 0.98, 3.04, 10.2],
  [0, 0.78, 1.76, 4.9, 22.1],
  [0, 0.24, 1.37, 4.02, 16.2, 35.3],
  [0, 0, 0.98, 3.61, 6.86, 16.2, 39.2],
  [0, 0, 0.46, 2.94, 4.41, 13.7, 30.4, 58.8],
  [0, 0, 0, 2.16, 3.92, 12.7, 21.6, 53.9, 68.6],
  [0, 0, 0, 1.52, 2.94, 7.84, 14.7, 43.1, 58.8, 83.3],
  [0, 0, 0, 1.37, 2.21, 4.41, 7.84, 16.7, 49, 78.4, 98]
];

const CRASH_K = 0.00018; // multiplicateur = exp(K × millisecondes)
const CRASH_MAX = 500;
const crashTime = (m: number) => Math.log(m) / CRASH_K;

type Card = { r: string; s: string };
const BJ_SUITS = ['♠', '♥', '♦', '♣'], BJ_RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const bjCardValue = (r: string) => r === 'A' ? 11 : ['J', 'Q', 'K'].includes(r) ? 10 : +r;
const bjTotal = (hand: Card[]) => { let t = 0, a = 0; for (const c of hand) { t += bjCardValue(c.r); if (c.r === 'A') a++; } while (t > 21 && a) { t -= 10; a--; } return t; };

// deno-lint-ignore no-explicit-any
type Sql = any;
// deno-lint-ignore no-explicit-any
type Round = { id: number; user_id: number; game: string; stake: number; state: any };

export function createCasino(sql: Sql, now = () => Date.now()) {
  // Exécute fn dans une transaction, après avoir verrouillé la ligne du joueur.
  const tx = <A extends unknown[], R>(fn: (t: Sql, id: number, ...args: A) => Promise<R>) =>
    (id: number, ...args: A): Promise<R> => sql.begin(async (t: Sql) => {
      const [u] = await t`select id from casino.users where id = ${id} for update`;
      if (!u) throw new HttpError(401, 'Session expirée.');
      return fn(t, id, ...args);
    });

  async function getUser(t: Sql, id: number) {
    const [u] = await t`select * from casino.users where id = ${id}`;
    if (!u) throw new HttpError(401, 'Session expirée.');
    return u;
  }

  /* ---------- Portefeuille ---------- */
  async function wallet(t: Sql, id: number) {
    const u = await getUser(t, id);
    return { balance: fromCents(u.balance), stats: { wagered: fromCents(u.wagered), won: fromCents(u.won), played: u.played, best: fromCents(u.best) } };
  }
  async function debit(t: Sql, id: number, amount: number, count = true) {
    const u = await getUser(t, id);
    if (amount > u.balance) throw bad('Solde insuffisant. Touchez + pour ajouter des jetons.');
    await t`update casino.users set balance = balance - ${amount}, wagered = wagered + ${amount}, played = played + ${count ? 1 : 0} where id = ${id}`;
  }
  // deno-lint-ignore no-explicit-any
  async function settle(t: Sql, id: number, game: string, stake: number, payout: number, details: any) {
    payout = Math.max(0, Math.round(payout));
    const net = payout - stake;
    await t`update casino.users set balance = balance + ${payout}, won = won + ${payout}, best = greatest(best, ${net}) where id = ${id}`;
    await t`insert into casino.transactions (user_id, kind, game, stake, payout, net, details, created_at)
            values (${id}, 'game', ${game}, ${stake}, ${payout}, ${net}, ${details ? t.json(details) : null}, ${now()})`;
    return { stake: fromCents(stake), payout: fromCents(payout), net: fromCents(net) };
  }

  const deposit = tx(async (t, id, amount: unknown) => {
    const a = Number(amount);
    if (!DEPOSITS.includes(a)) throw bad('Montant de dépôt invalide.');
    const c = a * 100;
    await t`update casino.users set balance = balance + ${c} where id = ${id}`;
    await t`insert into casino.transactions (user_id, kind, game, stake, payout, net, created_at) values (${id}, 'deposit', 'depot', 0, ${c}, ${c}, ${now()})`;
    return wallet(t, id);
  });
  const reset = tx(async (t, id) => {
    await t`delete from casino.active_rounds where user_id = ${id}`;
    await t`update casino.users set balance = ${START_BALANCE}, wagered = 0, won = 0, played = 0, best = 0 where id = ${id}`;
    await t`delete from casino.transactions where user_id = ${id}`;
    await t`insert into casino.transactions (user_id, kind, game, created_at) values (${id}, 'reset', 'reset', ${now()})`;
    return wallet(t, id);
  });
  async function history(id: number, limit = 30) {
    const rows = await sql`select game, net, created_at from casino.transactions where user_id = ${id} order by id desc limit ${limit}`;
    // deno-lint-ignore no-explicit-any
    return rows.map((r: any) => ({ g: r.game, net: fromCents(r.net), t: r.created_at }));
  }
  async function gameHistory(id: number, game: string, limit = 12) {
    const rows = game === 'crash'
      ? await sql`select details from casino.transactions where game = 'crash' order by id desc limit ${limit}`
      : await sql`select details from casino.transactions where user_id = ${id} and game = ${game} order by id desc limit ${limit}`;
    // deno-lint-ignore no-explicit-any
    return rows.map((r: any) => r.details).filter(Boolean);
  }
  async function leaderboard(limit = 10) {
    await crashSweep();
    const rows = await sql`select display_name, balance, best, played from casino.users where played > 0 order by balance desc, id limit ${limit}`;
    // deno-lint-ignore no-explicit-any
    return rows.map((r: any) => ({ name: r.display_name, balance: fromCents(r.balance), best: fromCents(r.best), played: r.played }));
  }

  async function loadRound(t: Sql, id: number, game: string): Promise<Round | undefined> {
    const [r] = await t`select * from casino.active_rounds where user_id = ${id} and game = ${game}`;
    return r;
  }
  const storeRound = (t: Sql, r: Round) => t`update casino.active_rounds set stake = ${r.stake}, state = ${t.json(r.state)} where id = ${r.id}`;
  const deleteRound = (t: Sql, r: Round) => t`delete from casino.active_rounds where id = ${r.id}`;
  // deno-lint-ignore no-explicit-any
  async function createRound(t: Sql, id: number, game: string, stake: number, state: any): Promise<Round> {
    const [r] = await t`insert into casino.active_rounds (user_id, game, stake, state, created_at)
                        values (${id}, ${game}, ${stake}, ${t.json(state)}, ${now()}) returning *`;
    return r;
  }
  const hasRound = async (t: Sql, id: number, game: string) => !!(await loadRound(t, id, game));

  /* ---------- Bandit d'Or ---------- */
  const slotSymbol = () => { let r = randInt(SLOT_TOTAL); for (const [s, w] of SLOT_SYMBOLS) { if ((r -= w) < 0) return s; } return 'cherry'; };
  // deno-lint-ignore no-explicit-any
  const slots = tx(async (t, id, { bet }: any) => {
    const stake = toCents(bet);
    await debit(t, id, stake);
    const reels = [0, 1, 2].map(() => [slotSymbol(), slotSymbol(), slotSymbol()]);
    const line = reels.map(r => r[1]);
    let mult = 0, idx: number[] = [];
    if (line[0] === line[1] && line[1] === line[2]) { mult = SLOT_PAY[line[0]]; idx = [0, 1, 2]; }
    else {
      const ch = line.map((s, i) => s === 'cherry' ? i : -1).filter(i => i >= 0);
      if (ch.length === 2) { mult = 3; idx = ch; }
    }
    const res = await settle(t, id, 'slots', stake, stake * mult, { line, mult });
    return { reels, mult, idx, ...res, wallet: await wallet(t, id) };
  });

  /* ---------- Roulette ---------- */
  function rlPay(key: string, n: number) {
    if (key.startsWith('n:')) return +key.slice(2) === n ? 36 : 0;
    if (n === 0) return 0;
    const simple: Record<string, boolean> = { red: RL_RED.has(n), black: !RL_RED.has(n), even: n % 2 === 0, odd: n % 2 === 1, low: n <= 18, high: n >= 19 };
    if (key in simple) return simple[key] ? 2 : 0;
    return ({ d1: n <= 12, d2: n > 12 && n <= 24, d3: n > 24 } as Record<string, boolean>)[key] ? 3 : 0;
  }
  // deno-lint-ignore no-explicit-any
  const roulette = tx(async (t, id, { bets }: any) => {
    if (!bets || typeof bets !== 'object' || Array.isArray(bets)) throw bad('Placez au moins un jeton sur le tapis.');
    const clean: Record<string, number> = {};
    for (const [k, v] of Object.entries(bets)) {
      const m = /^n:(\d{1,2})$/.exec(k);
      if (!(m && +m[1] <= 36) && !RL_OUTSIDE.includes(k)) throw bad('Mise de roulette invalide.');
      clean[k] = toCents(v);
    }
    const keys = Object.keys(clean);
    if (!keys.length) throw bad('Placez au moins un jeton sur le tapis.');
    const stake = keys.reduce((a, k) => a + clean[k], 0);
    await debit(t, id, stake);
    const n = randInt(37);
    const payout = keys.reduce((a, k) => a + clean[k] * rlPay(k, n), 0);
    const res = await settle(t, id, 'roulette', stake, payout, { n });
    return { n, ...res, wallet: await wallet(t, id) };
  });

  /* ---------- Dés ---------- */
  // deno-lint-ignore no-explicit-any
  const dice = tx(async (t, id, { bet, target, mode }: any) => {
    const x = Number(target);
    if (!Number.isInteger(x) || x < 2 || x > 98) throw bad('Seuil invalide (entre 2 et 98).');
    if (mode !== 'over' && mode !== 'under') throw bad('Mode invalide.');
    const stake = toCents(bet);
    await debit(t, id, stake);
    const chance = mode === 'over' ? 100 - x : x, mult = Math.floor(99 / chance * 10000) / 10000;
    const roll = randInt(10001) / 100, win = mode === 'over' ? roll > x : roll < x;
    const res = await settle(t, id, 'dice', stake, win ? stake * mult : 0, { roll, target: x, mode });
    return { roll, win, mult, ...res, wallet: await wallet(t, id) };
  });

  /* ---------- Pile ou face ---------- */
  // deno-lint-ignore no-explicit-any
  const coin = tx(async (t, id, { bet, pick }: any) => {
    const p = Number(pick);
    if (p !== 0 && p !== 1) throw bad('Choisissez pile ou face.');
    const stake = toCents(bet);
    await debit(t, id, stake);
    const result = randInt(2), win = result === p;
    const res = await settle(t, id, 'coin', stake, win ? stake * COIN_MULT : 0, { r: result });
    return { result, win, mult: COIN_MULT, ...res, wallet: await wallet(t, id) };
  });

  /* ---------- Keno ---------- */
  // deno-lint-ignore no-explicit-any
  const keno = tx(async (t, id, { bet, picks }: any) => {
    const chosen = Array.isArray(picks) ? [...new Set(picks.map(Number))] : [];
    if (!chosen.length || chosen.length > KENO_DRAW || chosen.length !== (picks as unknown[]).length || chosen.some(n => !Number.isInteger(n) || n < 1 || n > KENO_POOL)) throw bad('Choisissez de 1 à 10 numéros différents entre 1 et 40.');
    const stake = toCents(bet);
    await debit(t, id, stake);
    const drawn = shuffle(Array.from({ length: KENO_POOL }, (_, i) => i + 1)).slice(0, KENO_DRAW);
    const hits = drawn.filter(n => chosen.includes(n)), mult = KENO_PAY[chosen.length - 1][hits.length];
    const res = await settle(t, id, 'keno', stake, stake * mult, { picks: chosen.length, hits: hits.length, mult });
    return { drawn, hits, mult, ...res, wallet: await wallet(t, id) };
  });

  /* ---------- Plinko ---------- */
  // deno-lint-ignore no-explicit-any
  const plinko = tx(async (t, id, { bet, risk }: any) => {
    if (!PLINKO_SETS[risk]) throw bad('Niveau de risque invalide.');
    const stake = toCents(bet);
    await debit(t, id, stake);
    const path = Array.from({ length: PLINKO_ROWS }, () => randInt(2));
    const slot = path.reduce((a, b) => a + b, 0), mult = PLINKO_SETS[risk][slot];
    const res = await settle(t, id, 'plinko', stake, stake * mult, { slot, risk });
    return { path, slot, mult, ...res, wallet: await wallet(t, id) };
  });

  /* ---------- Mines ---------- */
  const minesView = (r: Round, over: boolean) => ({
    active: !over, mines: r.state.count, opened: r.state.opened, stake: fromCents(r.stake),
    mult: minesMult(r.state.count, r.state.opened.length), ...(over ? { minePositions: r.state.mines } : {})
  });
  async function minesCash(t: Sql, id: number, r: Round) {
    const m = minesMult(r.state.count, r.state.opened.length);
    await deleteRound(t, r);
    const res = await settle(t, id, 'mines', r.stake, r.stake * m, { mines: r.state.count, opened: r.state.opened.length, mult: m });
    return { ...minesView(r, true), cashed: true, mult: m, ...res };
  }
  // deno-lint-ignore no-explicit-any
  const minesStart = tx(async (t, id, { bet, mines }: any) => {
    const count = Number(mines);
    if (!MINES_COUNTS.includes(count)) throw bad('Nombre de mines invalide.');
    if (await hasRound(t, id, 'mines')) throw bad('Une partie de Mines est déjà en cours.');
    const stake = toCents(bet);
    await debit(t, id, stake);
    const positions = shuffle([...Array(25).keys()]).slice(0, count);
    const r = await createRound(t, id, 'mines', stake, { count, mines: positions, opened: [] });
    return { ...minesView(r, false), wallet: await wallet(t, id) };
  });
  // deno-lint-ignore no-explicit-any
  const minesReveal = tx(async (t, id, { tile }: any) => {
    const r = await loadRound(t, id, 'mines');
    if (!r) throw bad('Aucune partie de Mines en cours.');
    const i = Number(tile);
    if (!Number.isInteger(i) || i < 0 || i > 24) throw bad('Case invalide.');
    if (r.state.opened.includes(i)) throw bad('Case déjà retournée.');
    if (r.state.mines.includes(i)) {
      await deleteRound(t, r);
      const res = await settle(t, id, 'mines', r.stake, 0, { mines: r.state.count, opened: r.state.opened.length, mult: 0 });
      return { ...minesView(r, true), boom: true, tile: i, ...res, wallet: await wallet(t, id) };
    }
    r.state.opened.push(i);
    if (r.state.opened.length === 25 - r.state.count) return { ...(await minesCash(t, id, r)), tile: i, wallet: await wallet(t, id) };
    await storeRound(t, r);
    return { ...minesView(r, false), tile: i, wallet: await wallet(t, id) };
  });
  const minesCashout = tx(async (t, id) => {
    const r = await loadRound(t, id, 'mines');
    if (!r) throw bad('Aucune partie de Mines en cours.');
    if (!r.state.opened.length) throw bad('Retournez au moins une case avant d’encaisser.');
    return { ...(await minesCash(t, id, r)), wallet: await wallet(t, id) };
  });
  const minesState = async (id: number) => { const r = await loadRound(sql, id, 'mines'); return r ? minesView(r, false) : { active: false }; };

  /* ---------- Blackjack ---------- */
  const freshShoe = () => { const d: Card[] = []; for (let k = 0; k < 4; k++) for (const s of BJ_SUITS) for (const r of BJ_RANKS) d.push({ r, s }); return shuffle(d); };
  function bjView(r: Round, outcome?: string) {
    const { P, D } = r.state, done = !!outcome;
    return {
      active: !done, stake: fromCents(r.stake), player: P, playerTotal: bjTotal(P),
      dealer: done ? D : [D[0]], dealerTotal: done ? bjTotal(D) : bjTotal([D[0]]), hidden: !done,
      canDouble: !done && P.length === 2, ...(done ? { outcome } : {})
    };
  }
  async function bjFinish(t: Sql, id: number, r: Round, outcome: string) {
    await deleteRound(t, r);
    const mult = ({ win: 2, bj: 2.5, push: 1, lose: 0, bust: 0 } as Record<string, number>)[outcome];
    const res = await settle(t, id, 'bj', r.stake, r.stake * mult, { outcome, p: bjTotal(r.state.P), d: bjTotal(r.state.D) });
    return { ...bjView(r, outcome), ...res, wallet: await wallet(t, id) };
  }
  function bjDealerPlays(t: Sql, id: number, r: Round) {
    const { P, D, deck } = r.state;
    while (bjTotal(D) < 17) D.push(deck.pop());
    const p = bjTotal(P), d = bjTotal(D);
    return bjFinish(t, id, r, d > 21 || p > d ? 'win' : p === d ? 'push' : 'lose');
  }
  async function bjActive(t: Sql, id: number) { const r = await loadRound(t, id, 'bj'); if (!r) throw bad('Aucune main en cours.'); return r; }
  // deno-lint-ignore no-explicit-any
  const bjDeal = tx(async (t, id, { bet }: any) => {
    if (await hasRound(t, id, 'bj')) throw bad('Une main est déjà en cours.');
    const stake = toCents(bet);
    await debit(t, id, stake);
    const deck = freshShoe(), P: Card[] = [], D: Card[] = [];
    P.push(deck.pop()!); D.push(deck.pop()!); P.push(deck.pop()!); D.push(deck.pop()!);
    const r = await createRound(t, id, 'bj', stake, { deck, P, D });
    const pBJ = bjTotal(P) === 21, dBJ = bjTotal(D) === 21;
    if (pBJ || dBJ) return bjFinish(t, id, r, pBJ && dBJ ? 'push' : pBJ ? 'bj' : 'lose');
    return { ...bjView(r), wallet: await wallet(t, id) };
  });
  const bjHit = tx(async (t, id) => {
    const r = await bjActive(t, id);
    r.state.P.push(r.state.deck.pop());
    const total = bjTotal(r.state.P);
    if (total > 21) return bjFinish(t, id, r, 'bust');
    if (total === 21) return bjDealerPlays(t, id, r);
    await storeRound(t, r);
    return { ...bjView(r), wallet: await wallet(t, id) };
  });
  const bjStand = tx(async (t, id) => bjDealerPlays(t, id, await bjActive(t, id)));
  const bjDouble = tx(async (t, id) => {
    const r = await bjActive(t, id);
    if (r.state.P.length !== 2) throw bad('Vous ne pouvez doubler que sur vos deux premières cartes.');
    await debit(t, id, r.stake, false);
    r.stake *= 2;
    r.state.P.push(r.state.deck.pop());
    if (bjTotal(r.state.P) > 21) return bjFinish(t, id, r, 'bust');
    return bjDealerPlays(t, id, r);
  });
  const bjState = async (id: number) => { const r = await loadRound(sql, id, 'bj'); return r ? bjView(r) : { active: false }; };

  /* ---------- Fusée (crash) ---------- */
  // Le point d'explosion reste secret côté serveur jusqu'à la fin du vol.
  const crashMultAt = (r: Round, at: number) => Math.exp(CRASH_K * Math.max(0, at - r.state.startedAt));
  async function crashEnd(t: Sql, id: number, r: Round, cashedAt: number) {
    await deleteRound(t, r);
    const payout = cashedAt ? r.stake * cashedAt : 0;
    const res = await settle(t, id, 'crash', r.stake, payout, { round: r.id, crashAt: r.state.crashAt, cashedAt: cashedAt || 0 });
    return { crashAt: r.state.crashAt, cashedAt: cashedAt || 0, ...res };
  }
  // Règle une manche dont l'issue est déjà acquise (auto-encaissement atteint ou fusée explosée).
  async function crashSettleIfDue(t: Sql, id: number, at = now()) {
    const r = await loadRound(t, id, 'crash');
    if (!r) return null;
    const { crashAt, autoAt, startedAt } = r.state;
    if (autoAt && autoAt < crashAt && at >= startedAt + crashTime(autoAt)) return crashEnd(t, id, r, autoAt);
    if (at >= startedAt + crashTime(crashAt)) return crashEnd(t, id, r, 0);
    return null;
  }
  // deno-lint-ignore no-explicit-any
  const crashLaunch = tx(async (t, id, { bet, auto }: any) => {
    await crashSettleIfDue(t, id);
    if (await hasRound(t, id, 'crash')) throw bad('Une fusée est déjà en vol.');
    const stake = toCents(bet);
    let autoAt = 0;
    if (auto !== undefined && auto !== null && auto !== '') {
      autoAt = Math.floor(Number(String(auto).replace(',', '.')) * 100) / 100;
      if (!Number.isFinite(autoAt) || autoAt < 1.01) throw bad('Encaissement automatique invalide (minimum ×1,01).');
    }
    await debit(t, id, stake);
    const u = randFloat();
    const crashAt = Math.min(CRASH_MAX, Math.max(1, Math.floor(0.97 / (1 - u) * 100) / 100));
    const r = await createRound(t, id, 'crash', stake, { crashAt, autoAt, startedAt: now() });
    return { round: r.id, autoAt, wallet: await wallet(t, id) };
  });
  const crashCashout = tx(async (t, id) => {
    const at = now();
    const r = await loadRound(t, id, 'crash');
    if (!r) throw bad('Aucune fusée en vol.');
    const { crashAt, autoAt } = r.state;
    const cur = Math.floor(crashMultAt(r, at) * 100) / 100;
    let cash = autoAt && autoAt <= cur ? autoAt : cur;
    if (cash >= crashAt) cash = 0;
    return { ...(await crashEnd(t, id, r, cash)), wallet: await wallet(t, id) };
  });
  // Temps restant (ms) avant l'explosion de la manche indiquée, ou null si elle est terminée.
  async function crashRemaining(id: number, round?: number) {
    const r = await loadRound(sql, id, 'crash');
    if (!r || (round !== undefined && r.id !== Number(round))) return null;
    return Math.max(0, r.state.startedAt + crashTime(r.state.crashAt) - now());
  }
  const crashResolve = tx(async (t, id) => crashSettleIfDue(t, id));
  // Résultat d'une manche terminée (null si elle est toujours en vol ou inconnue).
  async function crashResult(id: number, round: number) {
    const [row] = await sql`select stake, payout, net, details from casino.transactions
                            where user_id = ${id} and game = 'crash' and (details->>'round')::bigint = ${round}
                            order by id desc limit 1`;
    if (!row) return null;
    const d = row.details;
    return { crashAt: d.crashAt, cashedAt: d.cashedAt, stake: fromCents(row.stake), payout: fromCents(row.payout), net: fromCents(row.net), wallet: await wallet(sql, id) };
  }
  async function crashState(id: number) {
    const r = await loadRound(sql, id, 'crash');
    return r ? { active: true, round: r.id, elapsed: now() - r.state.startedAt, autoAt: r.state.autoAt, stake: fromCents(r.stake) } : { active: false };
  }
  // Règle tous les vols terminés (le serveur n'a pas de minuterie permanente).
  async function crashSweep() {
    const rows = await sql`select user_id, state from casino.active_rounds where game = 'crash'`;
    // deno-lint-ignore no-explicit-any
    for (const r of rows as any[]) {
      const due = Math.min(r.state.startedAt + crashTime(r.state.crashAt), r.state.autoAt ? r.state.startedAt + crashTime(r.state.autoAt) : Infinity);
      if (now() >= due) await crashResolve(r.user_id);
    }
  }

  return {
    wallet: (id: number) => wallet(sql, id), deposit, reset, history, gameHistory, leaderboard,
    slots, roulette, dice, coin, plinko, keno,
    minesStart, minesReveal, minesCashout, minesState,
    bjDeal, bjHit, bjStand, bjDouble, bjState,
    crashLaunch, crashCashout, crashResolve, crashResult, crashRemaining, crashState, crashSweep
  };
}
