# Maison d’Or

Casino en jetons virtuels (gratuits et sans valeur réelle) : 9 jeux et comptes joueurs. En ligne, le backend et la base tournent sur Supabase (fonction Edge + Postgres). En local, un serveur Node.js + SQLite équivalent.

## En ligne

| Élément          | Où                                                                 |
| ---------------- | ------------------------------------------------------------------ |
| Base de données  | Supabase, projet « Maison d'Or » (`lzximhhtsttrlhfvwiqb`, Paris), schéma privé `casino` |
| API (backend)    | Fonction Edge Supabase `api` : `https://lzximhhtsttrlhfvwiqb.supabase.co/functions/v1/api` |
| Site web         | GitHub Pages, publié par `.github/workflows/pages.yml` depuis `public/` |

Supabase n'héberge pas de pages HTML (ses fonctions Edge et son Storage les servent en texte brut), d'où GitHub Pages pour le site. Le site trouve l'API grâce à `public/config.js`.

Mettre à jour :

- **API** : `supabase functions deploy api` (avec la CLI Supabase, depuis la racine du dépôt).
- **Schéma** : ajouter un fichier dans `supabase/migrations/`, puis `supabase db push`.
- **Site** : pousser sur `main` ; le workflow GitHub Pages republie `public/`.

La fonction s'exécute dans la région de la base (`forceFunctionRegion=eu-west-3`, réglé dans `config.js`), ce qui divise la latence par 5 à 8. Pour restreindre l'API au domaine du site, définissez le secret `ALLOWED_ORIGINS` de la fonction (par exemple `https://macksh.github.io`).

Tester l'API en ligne : `API_URL=https://lzximhhtsttrlhfvwiqb.supabase.co/functions/v1/api API_REGION=eu-west-3 npm test`.

## En local

```bash
npm install
npm start          # http://localhost:3000, avec une base SQLite locale
```

Variables d’environnement :

| Variable         | Par défaut         | Rôle                                         |
| ---------------- | ------------------ | -------------------------------------------- |
| `PORT`           | `3000`             | Port HTTP                                    |
| `DB_FILE`        | `data/casino.db`   | Fichier de la base SQLite (créé au besoin)   |
| `SECURE_COOKIES` | (vide)             | `1` pour des cookies `Secure` (derrière HTTPS) |

Tests : `npm test`.

## Jeux

| Jeu           | Principe                                                     | Gain max |
| ------------- | ------------------------------------------------------------ | -------- |
| Bandit d’Or   | Machine à sous 3 rouleaux, ligne centrale                     | ×100     |
| Roulette      | Européenne : pleins, douzaines, chances simples               | ×36      |
| Blackjack     | Sabot de 4 jeux, banque reste sur 17, blackjack 3 pour 2, doubler | ×2,5 |
| Fusée         | Crash : encaisser avant l’explosion (encaissement auto possible) | ×500  |
| Mines         | Grille 5×5, 1 à 20 mines                                      | ×50 000  |
| Plinko        | 8 rangées, 3 niveaux de risque, plusieurs billes à la suite   | ×29      |
| Dés           | Plus de / moins de, seuil de 2 à 98                           | ×49,5    |
| Pile ou face  | Une chance sur deux                                           | ×1,96    |
| Keno          | 40 numéros, 10 tirés ; choisir de 1 à 10 numéros              | ×98      |

## Architecture

```
supabase/
  migrations/ schéma Postgres
  functions/api/  API en ligne (Deno) : index.ts (routes, comptes), casino.ts (jeux)
server/       équivalent local Node.js + SQLite
  db.js       schéma SQLite (better-sqlite3)
  casino.js   portefeuille et logique de tous les jeux
  app.js      API Express, comptes et sessions
  index.js    point d’entrée
public/       interface (index.html, styles.css, app.js)
test/         tests de l’API (node:test)
```

Le serveur fait autorité : tout tirage utilise `crypto.randomInt`, et les mises et gains sont réglés dans une transaction (Postgres en ligne, SQLite en local). Les montants sont stockés en centimes de jeton. Le navigateur se contente d’animer le résultat reçu. Les informations secrètes restent sur le serveur jusqu’à la fin de la manche : la position des mines, la carte cachée de la banque et le point d’explosion de la fusée.

Les parties à état (Blackjack, Mines, Fusée) sont enregistrées dans `active_rounds`. Si vous quittez le jeu ou rechargez la page, la partie reprend. Si un vol de la fusée se termine pendant que la page est fermée, il est quand même réglé (encaissement automatique ou explosion), y compris après un redémarrage du serveur.

### Tables

- `users` : compte, solde, statistiques (misé, gagné, parties, meilleur gain), préférences (favoris, mises, son)
- `sessions` : jetons de session (30 jours), envoyés dans l'en-tête `X-MD-Session`
- `transactions` : historique de chaque partie, dépôt et remise à zéro
- `active_rounds` : parties en cours

### Comptes

Vous pouvez créer un compte (identifiant et mot de passe haché avec scrypt) ou jouer en invité. Un invité qui crée ensuite un compte garde son solde. Chaque nouveau joueur reçoit 1 000 jetons.

### API (JSON, préfixe `/api`)

| Méthode | Route                                   | Corps                              |
| ------- | --------------------------------------- | ---------------------------------- |
| POST    | `/auth/register`                        | `username, password, name?`        |
| POST    | `/auth/login`                           | `username, password`               |
| POST    | `/auth/guest`, `/auth/logout`           |                                    |
| GET     | `/auth/session`, `/me`                  |                                    |
| PATCH   | `/me`                                   | `name?, sound?, favs?, bets?`      |
| POST    | `/wallet/deposit`                       | `amount` (500, 1000, 2500, 10000)  |
| POST    | `/wallet/reset`                         |                                    |
| GET     | `/leaderboard`, `/games/:jeu/history`   |                                    |
| POST    | `/games/slots/spin`                     | `bet`                              |
| POST    | `/games/roulette/spin`                  | `bets` (`{"red": 5, "n:17": 1}`)   |
| POST    | `/games/dice/roll`                      | `bet, target, mode` (`over`/`under`) |
| POST    | `/games/coin/flip`                      | `bet, pick` (0 = pile, 1 = face)   |
| POST    | `/games/plinko/drop`                    | `bet, risk` (`low`/`mid`/`high`)   |
| POST    | `/games/keno/play`                      | `bet, picks` (1 à 10 numéros de 1 à 40) |
| GET/POST | `/games/mines/state`, `start`, `reveal`, `cashout` | `bet, mines` puis `tile` |
| GET/POST | `/games/bj/state`, `deal`, `hit`, `stand`, `double` | `bet` pour `deal`    |
| GET/POST | `/games/crash/state`, `launch`, `cashout`, `wait?round=` | `bet, auto?`    |

Chaque réponse de jeu contient `stake`, `payout`, `net` et `wallet` (le solde et les statistiques à jour).
