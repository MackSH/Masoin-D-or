'use strict';
// Logique du casino : portefeuille et jeux. Tout le hasard et tous les gains
// sont décidés ici, côté serveur ; le navigateur ne fait qu'animer le résultat.
const crypto = require('node:crypto');
const { START_BALANCE } = require('./db');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = msg => new HttpError(400, msg);

/* ---------- Hasard ---------- */
const randInt = n => crypto.randomInt(n);                       // entier dans [0, n)
const randFloat = () => crypto.randomBytes(6).readUIntBE(0, 6) / 2 ** 48; // réel dans [0, 1)
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = randInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };

/* ---------- Montants (centimes) ---------- */
const MIN_BET = 10; // 0,10 jeton
function toCents(x, what = 'mise') {
  const v = typeof x === 'string' ? Number(x.replace(',', '.')) : Number(x);
  if (!Number.isFinite(v) || v <= 0) throw bad(`Indiquez une ${what} valide.`);
  const c = Math.round(v * 100);
  if (c < MIN_BET) throw bad('La mise minimale est de 0,10 jeton.');
  if (c > 1e12) throw bad('Montant trop élevé.');
  return c;
}
const fromCents = c => c / 100;

/* ---------- Définitions des jeux ---------- */
const GAMES = ['slots', 'roulette', 'bj', 'crash', 'mines', 'plinko', 'dice', 'coin'];
const DEPOSITS = [500, 1000, 2500, 10000];

const SLOT_SYMBOLS = [['cherry', 22], ['lemon', 22], ['bell', 16], ['gem', 12], ['bar', 8], ['seven', 4]];
const SLOT_TOTAL = SLOT_SYMBOLS.reduce((a, [, w]) => a + w, 0);
const SLOT_PAY = { seven: 100, bar: 40, gem: 25, bell: 15, lemon: 8, cherry: 5 };

const RL_RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const RL_OUTSIDE = ['d1', 'd2', 'd3', 'low', 'high', 'even', 'odd', 'red', 'black'];

const MINES_COUNTS = [1, 3, 5, 10, 20];
const minesMult = (mines, k) => { if (!k) return 1; let m = 1; for (let i = 0; i < k; i++) m *= (25 - i) / (25 - mines - i); return Math.floor(m * 0.97 * 100) / 100; };

const PLINKO_ROWS = 8;
const PLINKO_SETS = {
  low: [5.6, 2.1, 1.1, 1, 0.5, 1, 1.1, 2.1, 5.6],
  mid: [13, 3, 1.3, 0.7, 0.4, 0.7, 1.3, 3, 13],
  high: [29, 4, 1.5, 0.3, 0.2, 0.3, 1.5, 4, 29]
};

const COIN_MULT = 1.96;

const CRASH_K = 0.00018; // multiplicateur = exp(K × millisecondes)
const CRASH_MAX = 500;
const crashTime = m => Math.log(m) / CRASH_K;

const BJ_SUITS = ['♠', '♥', '♦', '♣'], BJ_RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const bjCardValue = r => r === 'A' ? 11 : ['J', 'Q', 'K'].includes(r) ? 10 : +r;
const bjTotal = hand => { let t = 0, a = 0; for (const c of hand) { t += bjCardValue(c.r); if (c.r === 'A') a++; } while (t > 21 && a) { t -= 10; a--; } return t; };

function createCasino(db, { now = () => Date.now() } = {}) {
  const st = {
    user: db.prepare('SELECT * FROM users WHERE id = ?'),
    debit: db.prepare('UPDATE users SET balance = balance - @amount, wagered = wagered + @amount, played = played + @count WHERE id = @id'),
    credit: db.prepare('UPDATE users SET balance = balance + @payout, won = won + @payout, best = MAX(best, @net) WHERE id = @id'),
    tx: db.prepare('INSERT INTO transactions (user_id, kind, game, stake, payout, net, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    deposit: db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?'),
    reset: db.prepare(`UPDATE users SET balance = ${START_BALANCE}, wagered = 0, won = 0, played = 0, best = 0 WHERE id = ?`),
    clearTx: db.prepare('DELETE FROM transactions WHERE user_id = ?'),
    round: db.prepare('SELECT * FROM active_rounds WHERE user_id = ? AND game = ?'),
    roundsOf: db.prepare('SELECT * FROM active_rounds WHERE user_id = ?'),
    allCrash: db.prepare("SELECT * FROM active_rounds WHERE game = 'crash'"),
    newRound: db.prepare('INSERT INTO active_rounds (user_id, game, stake, state, created_at) VALUES (?, ?, ?, ?, ?)'),
    saveRound: db.prepare('UPDATE active_rounds SET stake = ?, state = ? WHERE id = ?'),
    delRound: db.prepare('DELETE FROM active_rounds WHERE id = ?'),
    hist: db.prepare('SELECT game, net, created_at FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT ?'),
    gameHist: db.prepare('SELECT details FROM transactions WHERE user_id = ? AND game = ? ORDER BY id DESC LIMIT ?'),
    crashResult: db.prepare("SELECT stake, payout, net, details FROM transactions WHERE user_id = ? AND game = 'crash' AND json_extract(details, '$.round') = ? ORDER BY id DESC LIMIT 1"),
    crashHist: db.prepare("SELECT details FROM transactions WHERE game = 'crash' ORDER BY id DESC LIMIT ?"),
    board: db.prepare('SELECT display_name, balance, best, played FROM users WHERE played > 0 ORDER BY balance DESC, id LIMIT ?')
  };

  const getUser = id => { const u = st.user.get(id); if (!u) throw new HttpError(401, 'Session expirée.'); return u; };

  /* ---------- Portefeuille ---------- */
  function wallet(id) {
    const u = getUser(id);
    return { balance: fromCents(u.balance), stats: { wagered: fromCents(u.wagered), won: fromCents(u.won), played: u.played, best: fromCents(u.best) } };
  }
  function debit(id, amount, count = true) {
    const u = getUser(id);
    if (amount > u.balance) throw bad('Solde insuffisant. Touchez + pour ajouter des jetons.');
    st.debit.run({ id, amount, count: count ? 1 : 0 });
  }
  function settle(id, game, stake, payout, details) {
    payout = Math.max(0, Math.round(payout));
    const net = payout - stake;
    st.credit.run({ id, payout, net });
    st.tx.run(id, 'game', game, stake, payout, net, details ? JSON.stringify(details) : null, now());
    return { stake: fromCents(stake), payout: fromCents(payout), net: fromCents(net) };
  }
  const tx = fn => db.transaction(fn);

  const deposit = tx((id, amount) => {
    amount = Number(amount);
    if (!DEPOSITS.includes(amount)) throw bad('Montant de dépôt invalide.');
    const c = amount * 100;
    st.deposit.run(c, id);
    st.tx.run(id, 'deposit', 'depot', 0, c, c, null, now());
    return wallet(id);
  });
  const reset = tx(id => {
    for (const r of st.roundsOf.all(id)) st.delRound.run(r.id);
    st.reset.run(id); st.clearTx.run(id);
    st.tx.run(id, 'reset', 'reset', 0, 0, 0, null, now());
    return wallet(id);
  });
  const history = (id, limit = 30) => st.hist.all(id, limit).map(r => ({ g: r.game, net: fromCents(r.net), t: r.created_at }));
  const gameHistory = (id, game, limit = 12) => {
    const rows = game === 'crash' ? st.crashHist.all(limit) : st.gameHist.all(id, game, limit);
    return rows.map(r => r.details && JSON.parse(r.details)).filter(Boolean);
  };
  const leaderboard = (limit = 10) => st.board.all(limit).map(r => ({ name: r.display_name, balance: fromCents(r.balance), best: fromCents(r.best), played: r.played }));

  const loadRound = (id, game) => { const r = st.round.get(id, game); return r && { ...r, state: JSON.parse(r.state) }; };
  const storeRound = r => st.saveRound.run(r.stake, JSON.stringify(r.state), r.id);
  const createRound = (id, game, stake, state) => {
    const info = st.newRound.run(id, game, stake, JSON.stringify(state), now());
    return { id: Number(info.lastInsertRowid), user_id: id, game, stake, state };
  };

  /* ---------- Bandit d'Or ---------- */
  const slotSymbol = () => { let r = randInt(SLOT_TOTAL); for (const [s, w] of SLOT_SYMBOLS) { if ((r -= w) < 0) return s; } return 'cherry'; };
  const slots = tx((id, { bet }) => {
    const stake = toCents(bet);
    debit(id, stake);
    const reels = [0, 1, 2].map(() => [slotSymbol(), slotSymbol(), slotSymbol()]);
    const line = reels.map(r => r[1]);
    let mult = 0, idx = [];
    if (line[0] === line[1] && line[1] === line[2]) { mult = SLOT_PAY[line[0]]; idx = [0, 1, 2]; }
    else {
      const ch = line.map((s, i) => s === 'cherry' ? i : -1).filter(i => i >= 0);
      if (ch.length === 2) { mult = 3; idx = ch; }
    }
    const res = settle(id, 'slots', stake, stake * mult, { line, mult });
    return { reels, mult, idx, ...res, wallet: wallet(id) };
  });

  /* ---------- Roulette ---------- */
  function rlPay(key, n) {
    if (key.startsWith('n:')) return +key.slice(2) === n ? 36 : 0;
    if (n === 0) return 0;
    const simple = { red: RL_RED.has(n), black: !RL_RED.has(n), even: n % 2 === 0, odd: n % 2 === 1, low: n <= 18, high: n >= 19 };
    if (key in simple) return simple[key] ? 2 : 0;
    return { d1: n <= 12, d2: n > 12 && n <= 24, d3: n > 24 }[key] ? 3 : 0;
  }
  const roulette = tx((id, { bets }) => {
    if (!bets || typeof bets !== 'object' || Array.isArray(bets)) throw bad('Placez au moins un jeton sur le tapis.');
    const clean = {};
    for (const [k, v] of Object.entries(bets)) {
      const m = /^n:(\d{1,2})$/.exec(k);
      if (!(m && +m[1] <= 36) && !RL_OUTSIDE.includes(k)) throw bad('Mise de roulette invalide.');
      clean[k] = toCents(v);
    }
    const keys = Object.keys(clean);
    if (!keys.length) throw bad('Placez au moins un jeton sur le tapis.');
    const stake = keys.reduce((a, k) => a + clean[k], 0);
    debit(id, stake);
    const n = randInt(37);
    const payout = keys.reduce((a, k) => a + clean[k] * rlPay(k, n), 0);
    const res = settle(id, 'roulette', stake, payout, { n });
    return { n, ...res, wallet: wallet(id) };
  });

  /* ---------- Dés ---------- */
  const dice = tx((id, { bet, target, mode }) => {
    const x = Number(target);
    if (!Number.isInteger(x) || x < 2 || x > 98) throw bad('Seuil invalide (entre 2 et 98).');
    if (mode !== 'over' && mode !== 'under') throw bad('Mode invalide.');
    const stake = toCents(bet);
    debit(id, stake);
    const chance = mode === 'over' ? 100 - x : x, mult = Math.floor(99 / chance * 10000) / 10000;
    const roll = randInt(10001) / 100, win = mode === 'over' ? roll > x : roll < x;
    const res = settle(id, 'dice', stake, win ? stake * mult : 0, { roll, target: x, mode });
    return { roll, win, mult, ...res, wallet: wallet(id) };
  });

  /* ---------- Pile ou face ---------- */
  const coin = tx((id, { bet, pick }) => {
    const p = Number(pick);
    if (p !== 0 && p !== 1) throw bad('Choisissez pile ou face.');
    const stake = toCents(bet);
    debit(id, stake);
    const result = randInt(2), win = result === p;
    const res = settle(id, 'coin', stake, win ? stake * COIN_MULT : 0, { r: result });
    return { result, win, mult: COIN_MULT, ...res, wallet: wallet(id) };
  });

  /* ---------- Plinko ---------- */
  const plinko = tx((id, { bet, risk }) => {
    if (!PLINKO_SETS[risk]) throw bad('Niveau de risque invalide.');
    const stake = toCents(bet);
    debit(id, stake);
    const path = Array.from({ length: PLINKO_ROWS }, () => randInt(2));
    const slot = path.reduce((a, b) => a + b, 0), mult = PLINKO_SETS[risk][slot];
    const res = settle(id, 'plinko', stake, stake * mult, { slot, risk });
    return { path, slot, mult, ...res, wallet: wallet(id) };
  });

  /* ---------- Mines ---------- */
  const minesView = (r, over) => ({
    active: !over, mines: r.state.count, opened: r.state.opened, stake: fromCents(r.stake),
    mult: minesMult(r.state.count, r.state.opened.length), ...(over ? { minePositions: r.state.mines } : {})
  });
  function minesCash(id, r) {
    const m = minesMult(r.state.count, r.state.opened.length);
    st.delRound.run(r.id);
    const res = settle(id, 'mines', r.stake, r.stake * m, { mines: r.state.count, opened: r.state.opened.length, mult: m });
    return { ...minesView(r, true), cashed: true, mult: m, ...res };
  }
  const minesStart = tx((id, { bet, mines }) => {
    const count = Number(mines);
    if (!MINES_COUNTS.includes(count)) throw bad('Nombre de mines invalide.');
    if (st.round.get(id, 'mines')) throw bad('Une partie de Mines est déjà en cours.');
    const stake = toCents(bet);
    debit(id, stake);
    const positions = shuffle([...Array(25).keys()]).slice(0, count);
    const r = createRound(id, 'mines', stake, { count, mines: positions, opened: [] });
    return { ...minesView(r, false), wallet: wallet(id) };
  });
  const minesReveal = tx((id, { tile }) => {
    const r = loadRound(id, 'mines');
    if (!r) throw bad('Aucune partie de Mines en cours.');
    const i = Number(tile);
    if (!Number.isInteger(i) || i < 0 || i > 24) throw bad('Case invalide.');
    if (r.state.opened.includes(i)) throw bad('Case déjà retournée.');
    if (r.state.mines.includes(i)) {
      st.delRound.run(r.id);
      const res = settle(id, 'mines', r.stake, 0, { mines: r.state.count, opened: r.state.opened.length, mult: 0 });
      return { ...minesView(r, true), boom: true, tile: i, ...res, wallet: wallet(id) };
    }
    r.state.opened.push(i);
    if (r.state.opened.length === 25 - r.state.count) return { ...minesCash(id, r), tile: i, wallet: wallet(id) };
    storeRound(r);
    return { ...minesView(r, false), tile: i, wallet: wallet(id) };
  });
  const minesCashout = tx(id => {
    const r = loadRound(id, 'mines');
    if (!r) throw bad('Aucune partie de Mines en cours.');
    if (!r.state.opened.length) throw bad('Retournez au moins une case avant d’encaisser.');
    return { ...minesCash(id, r), wallet: wallet(id) };
  });
  const minesState = id => { const r = loadRound(id, 'mines'); return r ? minesView(r, false) : { active: false }; };

  /* ---------- Blackjack ---------- */
  const freshShoe = () => { const d = []; for (let k = 0; k < 4; k++) for (const s of BJ_SUITS) for (const r of BJ_RANKS) d.push({ r, s }); return shuffle(d); };
  function bjView(r, outcome) {
    const { P, D } = r.state, done = !!outcome;
    return {
      active: !done, stake: fromCents(r.stake), player: P, playerTotal: bjTotal(P),
      dealer: done ? D : [D[0]], dealerTotal: done ? bjTotal(D) : bjTotal([D[0]]), hidden: !done,
      canDouble: !done && P.length === 2, ...(done ? { outcome } : {})
    };
  }
  function bjFinish(id, r, outcome) {
    st.delRound.run(r.id);
    const mult = { win: 2, bj: 2.5, push: 1, lose: 0, bust: 0 }[outcome];
    const res = settle(id, 'bj', r.stake, r.stake * mult, { outcome, p: bjTotal(r.state.P), d: bjTotal(r.state.D) });
    return { ...bjView(r, outcome), ...res, wallet: wallet(id) };
  }
  function bjDealerPlays(id, r) {
    const { P, D, deck } = r.state;
    while (bjTotal(D) < 17) D.push(deck.pop());
    const p = bjTotal(P), d = bjTotal(D);
    return bjFinish(id, r, d > 21 || p > d ? 'win' : p === d ? 'push' : 'lose');
  }
  const bjActive = id => { const r = loadRound(id, 'bj'); if (!r) throw bad('Aucune main en cours.'); return r; };
  const bjDeal = tx((id, { bet }) => {
    if (st.round.get(id, 'bj')) throw bad('Une main est déjà en cours.');
    const stake = toCents(bet);
    debit(id, stake);
    const deck = freshShoe(), P = [], D = [];
    P.push(deck.pop()); D.push(deck.pop()); P.push(deck.pop()); D.push(deck.pop());
    const r = createRound(id, 'bj', stake, { deck, P, D });
    const pBJ = bjTotal(P) === 21, dBJ = bjTotal(D) === 21;
    if (pBJ || dBJ) return bjFinish(id, r, pBJ && dBJ ? 'push' : pBJ ? 'bj' : 'lose');
    return { ...bjView(r), wallet: wallet(id) };
  });
  const bjHit = tx(id => {
    const r = bjActive(id);
    r.state.P.push(r.state.deck.pop());
    const t = bjTotal(r.state.P);
    if (t > 21) return bjFinish(id, r, 'bust');
    if (t === 21) return bjDealerPlays(id, r);
    storeRound(r);
    return { ...bjView(r), wallet: wallet(id) };
  });
  const bjStand = tx(id => bjDealerPlays(id, bjActive(id)));
  const bjDouble = tx(id => {
    const r = bjActive(id);
    if (r.state.P.length !== 2) throw bad('Vous ne pouvez doubler que sur vos deux premières cartes.');
    debit(id, r.stake, false);
    r.stake *= 2;
    r.state.P.push(r.state.deck.pop());
    if (bjTotal(r.state.P) > 21) return bjFinish(id, r, 'bust');
    return bjDealerPlays(id, r);
  });
  const bjState = id => { const r = loadRound(id, 'bj'); return r ? bjView(r) : { active: false }; };

  /* ---------- Fusée (crash) ---------- */
  // Le point d'explosion reste secret côté serveur jusqu'à la fin du vol.
  const crashMultAt = (r, t) => Math.exp(CRASH_K * Math.max(0, t - r.state.startedAt));
  function crashEnd(id, r, cashedAt) {
    st.delRound.run(r.id);
    const payout = cashedAt ? r.stake * cashedAt : 0;
    const res = settle(id, 'crash', r.stake, payout, { round: r.id, crashAt: r.state.crashAt, cashedAt: cashedAt || 0 });
    return { crashAt: r.state.crashAt, cashedAt: cashedAt || 0, ...res };
  }
  // Règle une manche dont l'issue est déjà acquise (auto-encaissement atteint ou fusée explosée).
  function crashSettleIfDue(id, t = now()) {
    const r = loadRound(id, 'crash');
    if (!r) return null;
    const { crashAt, autoAt, startedAt } = r.state;
    if (autoAt && autoAt < crashAt && t >= startedAt + crashTime(autoAt)) return crashEnd(id, r, autoAt);
    if (t >= startedAt + crashTime(crashAt)) return crashEnd(id, r, 0);
    return null;
  }
  const crashLaunch = tx((id, { bet, auto }) => {
    crashSettleIfDue(id);
    if (st.round.get(id, 'crash')) throw bad('Une fusée est déjà en vol.');
    const stake = toCents(bet);
    let autoAt = 0;
    if (auto !== undefined && auto !== null && auto !== '') {
      autoAt = Math.floor(Number(String(auto).replace(',', '.')) * 100) / 100;
      if (!Number.isFinite(autoAt) || autoAt < 1.01) throw bad('Encaissement automatique invalide (minimum ×1,01).');
    }
    debit(id, stake);
    const u = randFloat();
    const crashAt = Math.min(CRASH_MAX, Math.max(1, Math.floor(0.97 / (1 - u) * 100) / 100));
    const startedAt = now();
    const r = createRound(id, 'crash', stake, { crashAt, autoAt, startedAt });
    return { round: r.id, autoAt, wallet: wallet(id) };
  });
  const crashCashout = tx(id => {
    const t = now();
    const r = loadRound(id, 'crash');
    if (!r) throw bad('Aucune fusée en vol.');
    const { crashAt, autoAt } = r.state;
    const cur = Math.floor(crashMultAt(r, t) * 100) / 100;
    let at = autoAt && autoAt <= cur ? autoAt : cur;
    if (at >= crashAt) at = 0;
    return { ...crashEnd(id, r, at), wallet: wallet(id) };
  });
  // Temps restant (ms) avant que la manche en cours soit réglée, ou null.
  function crashRemaining(id, round) {
    const r = loadRound(id, 'crash');
    if (!r || (round !== undefined && r.id !== Number(round))) return null;
    return Math.max(0, r.state.startedAt + crashTime(r.state.crashAt) - now());
  }
  const crashResolve = tx(id => crashSettleIfDue(id));
  // Résultat d'une manche terminée (null si elle est toujours en vol ou inconnue).
  function crashResult(id, round) {
    const row = st.crashResult.get(id, Number(round));
    if (!row) return null;
    const d = JSON.parse(row.details);
    return { crashAt: d.crashAt, cashedAt: d.cashedAt, stake: fromCents(row.stake), payout: fromCents(row.payout), net: fromCents(row.net), wallet: wallet(id) };
  }
  const crashState = id => {
    const r = loadRound(id, 'crash');
    return r ? { active: true, round: r.id, elapsed: now() - r.state.startedAt, autoAt: r.state.autoAt, stake: fromCents(r.stake) } : { active: false };
  };
  // Au démarrage du serveur : règle les vols qui se sont terminés pendant l'arrêt.
  const crashSweep = tx(() => { for (const r of st.allCrash.all()) crashSettleIfDue(r.user_id); });

  return {
    wallet, deposit, reset, history, gameHistory, leaderboard,
    slots, roulette, dice, coin, plinko,
    minesStart, minesReveal, minesCashout, minesState,
    bjDeal, bjHit, bjStand, bjDouble, bjState,
    crashLaunch, crashCashout, crashResolve, crashResult, crashRemaining, crashState, crashSweep
  };
}

module.exports = {
  createCasino, HttpError, toCents, bjTotal, minesMult, crashTime,
  GAMES, DEPOSITS, PLINKO_SETS, SLOT_PAY, COIN_MULT, CRASH_K
};
