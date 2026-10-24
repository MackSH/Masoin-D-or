'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../server/db');
const { createApp } = require('../server/app');
const { minesMult, bjTotal, KENO_PAY } = require('../server/casino');

// Par défaut, les tests démarrent le serveur Node + SQLite en mémoire.
// Avec API_URL (et API_REGION), ils visent une API déjà déployée, par exemple la fonction Edge Supabase.
let server, base, db;
before(async () => {
  if (process.env.API_URL) { base = process.env.API_URL.replace(/\/$/, ''); return; }
  db = open(':memory:');
  server = createApp(db).listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => { if (server) { server.close(); db.close(); } });

// Petit client HTTP qui garde le jeton de session.
function client() {
  let token = '';
  return async function call(path, body, method) {
    const url = new URL(base + path);
    if (process.env.API_REGION) url.searchParams.set('forceFunctionRegion', process.env.API_REGION);
    const res = await fetch(url, {
      method: method || (body !== undefined ? 'POST' : 'GET'),
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { 'X-MD-Session': token } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const data = await res.json();
    if (data.token) token = data.token;
    if (path === '/auth/logout') token = '';
    return { status: res.status, body: data };
  };
}
const balanceOf = async c => (await c('/me')).body.wallet.balance;
const SUF = Date.now().toString(36); // identifiants uniques quand la base persiste
const approx = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} ≠ ${b}`);

test('inscription, connexion, déconnexion', async () => {
  const c = client();
  assert.equal((await c('/me')).status, 401);
  assert.deepEqual((await c('/auth/session')).body, { user: null });
  const r = await c('/auth/register', { username: `alice${SUF}`, password: 'secret1', name: 'Alice' });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.name, 'Alice');
  assert.equal(r.body.wallet.balance, 1000);
  assert.equal((await c('/auth/register', { username: `ALICE${SUF}`, password: 'secret1' })).status, 409);
  await c('/auth/logout', {});
  assert.equal((await c('/me')).status, 401);
  assert.equal((await c('/auth/login', { username: `alice${SUF}`, password: 'mauvais' })).status, 401);
  const ok = await c('/auth/login', { username: `Alice${SUF}`, password: 'secret1' });
  assert.equal(ok.status, 200);
  assert.equal((await c('/me')).body.user.username, `alice${SUF}`);
});

test('un invité qui crée un compte garde son solde', async () => {
  const c = client();
  await c('/auth/guest', {});
  await c('/wallet/deposit', { amount: 500 });
  const r = await c('/auth/register', { username: `bob${SUF}`, password: 'secret1' });
  assert.equal(r.body.user.guest, false);
  assert.equal(r.body.wallet.balance, 1500);
});

test('préférences, dépôt et remise à zéro', async () => {
  const c = client();
  await c('/auth/guest', {});
  const p = await c('/me', { name: '  Zoé  ', favs: ['dice', 'nope'], sound: false, bets: { dice: 2.5 } }, 'PATCH');
  assert.deepEqual(p.body.user.favs, ['dice']);
  assert.equal(p.body.user.name, 'Zoé');
  assert.equal(p.body.user.sound, false);
  assert.equal(p.body.user.bets.dice, 2.5);
  assert.equal((await c('/wallet/deposit', { amount: 123 })).status, 400);
  assert.equal((await c('/wallet/deposit', { amount: 10000 })).body.wallet.balance, 11000);
  await c('/games/coin/flip', { bet: 5, pick: 0 });
  const r = await c('/wallet/reset', {});
  assert.equal(r.body.wallet.balance, 1000);
  assert.equal(r.body.wallet.stats.played, 0);
});

test('mises invalides ou supérieures au solde', async () => {
  const c = client();
  await c('/auth/guest', {});
  assert.equal((await c('/games/dice/roll', { bet: 5000, target: 50, mode: 'over' })).status, 400);
  assert.equal((await c('/games/dice/roll', { bet: -1, target: 50, mode: 'over' })).status, 400);
  assert.equal((await c('/games/dice/roll', { bet: 0.01, target: 50, mode: 'over' })).status, 400);
  assert.equal((await c('/games/dice/roll', { bet: 1, target: 99, mode: 'over' })).status, 400);
  assert.equal((await c('/games/roulette/spin', { bets: { 'n:37': 1 } })).status, 400);
  assert.equal((await c('/games/plinko/drop', { bet: 1, risk: 'x' })).status, 400);
  assert.equal(await balanceOf(c), 1000);
});

test('jeux instantanés : le solde suit exactement les gains', async () => {
  const c = client();
  await c('/auth/guest', {});
  let bal = 1000;
  const calls = [
    ['/games/slots/spin', { bet: 1 }],
    ['/games/roulette/spin', { bets: { red: 1, 'n:17': 0.5, d2: 1 } }],
    ['/games/dice/roll', { bet: 1, target: 40, mode: 'under' }],
    ['/games/coin/flip', { bet: 1, pick: 1 }],
    ['/games/plinko/drop', { bet: 1, risk: 'high' }]
  ];
  for (let i = 0; i < 30; i++) {
    for (const [path, body] of calls) {
      const r = await c(path, body);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      bal = Math.round((bal + r.body.net) * 100) / 100;
      approx(r.body.wallet.balance, bal);
      approx(r.body.net, r.body.payout - r.body.stake);
    }
  }
  const me = (await c('/me')).body;
  assert.equal(me.wallet.stats.played, 150);
  assert.equal(me.hist.length, 30);
});

test('détails des jeux instantanés', async () => {
  const c = client();
  await c('/auth/guest', {});
  const s = (await c('/games/slots/spin', { bet: 1 })).body;
  assert.equal(s.reels.length, 3);
  const line = s.reels.map(r => r[1]);
  if (line.every(x => x === line[0])) assert.ok(s.mult >= 5); else if (line.filter(x => x === 'cherry').length === 2) assert.equal(s.mult, 3); else assert.equal(s.mult, 0);

  const d = (await c('/games/dice/roll', { bet: 1, target: 50, mode: 'over' })).body;
  assert.equal(d.win, d.roll > 50);
  assert.equal(d.mult, 1.98);

  const p = (await c('/games/plinko/drop', { bet: 1, risk: 'low' })).body;
  assert.equal(p.path.length, 8);
  assert.equal(p.slot, p.path.reduce((a, b) => a + b, 0));

  const r = (await c('/games/roulette/spin', { bets: { [`n:${7}`]: 1 } })).body;
  assert.equal(r.payout, r.n === 7 ? 36 : 0);
  const h = (await c('/games/roulette/history')).body;
  assert.equal(h.items[0].n, r.n);
});

test('mines : partie complète, mine et encaissement', async () => {
  const c = client();
  await c('/auth/guest', {});
  assert.equal((await c('/games/mines/cashout', {})).status, 400);
  const s = await c('/games/mines/start', { bet: 10, mines: 3 });
  assert.equal(s.status, 200);
  assert.equal(s.body.minePositions, undefined, 'les mines ne doivent pas fuiter');
  assert.equal(s.body.wallet.balance, 990);
  assert.equal((await c('/games/mines/start', { bet: 10, mines: 3 })).status, 400);
  assert.equal((await c('/games/mines/cashout', {})).status, 400);
  const st = await c('/games/mines/state');
  assert.equal(st.body.active, true);
  // Retourne les cases une à une jusqu'à tomber sur une mine ou encaisser après 2 diamants.
  let opened = 0, last;
  for (let i = 0; i < 25; i++) {
    last = (await c('/games/mines/reveal', { tile: i })).body;
    if (last.boom) break;
    opened++;
    if (opened === 2) { last = (await c('/games/mines/cashout', {})).body; break; }
  }
  if (last.boom) { assert.equal(last.payout, 0); assert.equal(last.minePositions.length, 3); }
  else { assert.equal(last.cashed, true); approx(last.payout, Math.round(10 * minesMult(3, 2) * 100) / 100); }
  approx(last.wallet.balance, 990 + last.payout);
  assert.equal((await c('/games/mines/state')).body.active, false);
});

test('blackjack : la main se termine et paie correctement', async () => {
  const c = client();
  await c('/auth/guest', {});
  for (let n = 0; n < 15; n++) {
    const before = await balanceOf(c);
    let r = (await c('/games/bj/deal', { bet: 10 })).body;
    if (r.active) {
      assert.equal(r.dealer.length, 1, 'la carte cachée ne doit pas fuiter');
      assert.equal((await c('/games/bj/deal', { bet: 10 })).status, 400);
      while (r.active && r.playerTotal < 15) r = (await c('/games/bj/hit', {})).body;
      if (r.active) r = (await c(n % 2 || !r.canDouble ? '/games/bj/stand' : '/games/bj/double', {})).body;
    }
    assert.ok(r.outcome, JSON.stringify(r));
    assert.equal(r.playerTotal, bjTotal(r.player));
    assert.equal(r.dealerTotal, bjTotal(r.dealer));
    const mult = { win: 2, bj: 2.5, push: 1, lose: 0, bust: 0 }[r.outcome];
    approx(r.payout, r.stake * mult);
    approx(r.wallet.balance, before - r.stake + r.payout);
    if (['win', 'lose', 'push'].includes(r.outcome) && r.player.length > 2) assert.ok(r.dealerTotal >= 17 || r.playerTotal > 21);
  }
  assert.equal((await c('/games/bj/hit', {})).status, 400);
});

test('fusée : encaissement manuel, auto et explosion', async () => {
  const c = client();
  await c('/auth/guest', {});
  let l = await c('/games/crash/launch', { bet: 10 });
  assert.equal(l.status, 200);
  assert.equal(l.body.crashAt, undefined, 'le point d’explosion ne doit pas fuiter');
  // Une deuxième fusée est refusée tant que la première vole, sauf si celle-ci a explosé au départ (×1,00).
  const second = await c('/games/crash/launch', { bet: 10 });
  if (second.status === 200) {
    assert.equal((await c(`/games/crash/wait?round=${l.body.round}`)).body.crashAt, 1);
    l = second;
  } else assert.equal(second.status, 400);
  const out = (await c('/games/crash/cashout', {})).body;
  if (out.cashedAt > 0) { assert.ok(out.cashedAt < out.crashAt); approx(out.payout, Math.round(10 * out.cashedAt * 100) / 100); }
  else assert.equal(out.payout, 0);
  // Le résultat reste consultable via l'attente longue.
  const w = (await c(`/games/crash/wait?round=${l.body.round}`)).body;
  assert.equal(w.crashAt, out.crashAt);
  // Encaisser une manche déjà terminée renvoie son résultat au lieu d'une erreur.
  const again = await c('/games/crash/cashout', { round: l.body.round });
  assert.equal(again.status, 200);
  assert.equal(again.body.crashAt, out.crashAt);

  // Encaissement automatique à ×1,01 : l'attente longue renvoie l'issue.
  const l2 = (await c('/games/crash/launch', { bet: 10, auto: 1.01 })).body;
  const w2 = (await c(`/games/crash/wait?round=${l2.round}`)).body;
  if (w2.crashAt > 1.01) { assert.equal(w2.cashedAt, 1.01); approx(w2.payout, 10.1); } else assert.equal(w2.payout, 0);
  assert.equal((await c('/games/crash/state')).body.active, false);
  const hist = (await c('/games/crash/history')).body.items;
  assert.equal(hist[0].crashAt, w2.crashAt);
});

test('keno : tirage, bons numéros et gains', async () => {
  const c = client();
  await c('/auth/guest', {});
  for (const bad of [[], [0], [41], [1, 1], [1.5], Array.from({ length: 11 }, (_, i) => i + 1), 'x']) {
    assert.equal((await c('/games/keno/play', { bet: 1, picks: bad })).status, 400, JSON.stringify(bad));
  }
  let bal = 1000;
  for (let n = 1; n <= 10; n++) {
    const picks = Array.from({ length: n }, (_, i) => i * 4 + 1);
    const r = (await c('/games/keno/play', { bet: 2, picks })).body;
    assert.equal(r.drawn.length, 10);
    assert.equal(new Set(r.drawn).size, 10);
    assert.ok(r.drawn.every(x => Number.isInteger(x) && x >= 1 && x <= 40));
    assert.deepEqual(r.hits, r.drawn.filter(x => picks.includes(x)));
    assert.equal(r.mult, KENO_PAY[n - 1][r.hits.length]);
    approx(r.payout, Math.round(2 * r.mult * 100) / 100);
    bal = Math.round((bal + r.net) * 100) / 100;
    approx(r.wallet.balance, bal);
  }
});

test('classement', async () => {
  const c = client();
  await c('/auth/guest', {});
  const r = await c('/leaderboard');
  assert.equal(r.status, 200);
  assert.ok(r.body.players.length > 0);
  assert.ok(r.body.players.every((p, i, a) => !i || a[i - 1].balance >= p.balance));
});
