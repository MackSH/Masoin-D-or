# Maison d’Or

Casino en jetons virtuels (gratuits et sans valeur réelle) : 8 jeux, comptes joueurs et backend Node.js + SQLite.

## Démarrer

```bash
npm install
npm start          # http://localhost:3000
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

## Architecture

```
server/
  db.js       schéma SQLite (better-sqlite3)
  casino.js   portefeuille et logique de tous les jeux
  app.js      API Express, comptes et sessions
  index.js    point d’entrée
public/       interface (index.html, styles.css, app.js)
test/         tests de l’API (node:test)
```

Le serveur fait autorité : tout tirage utilise `crypto.randomInt`, et les mises et gains sont réglés dans une transaction SQLite. Les montants sont stockés en centimes de jeton. Le navigateur se contente d’animer le résultat reçu. Les informations secrètes restent sur le serveur jusqu’à la fin de la manche : la position des mines, la carte cachée de la banque et le point d’explosion de la fusée.

Les parties à état (Blackjack, Mines, Fusée) sont enregistrées dans `active_rounds`. Si vous quittez le jeu ou rechargez la page, la partie reprend. Si un vol de la fusée se termine pendant que la page est fermée, il est quand même réglé (encaissement automatique ou explosion), y compris après un redémarrage du serveur.

### Tables

- `users` : compte, solde, statistiques (misé, gagné, parties, meilleur gain), préférences (favoris, mises, son)
- `sessions` : jetons de session (cookie `httpOnly`, 30 jours)
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
| GET/POST | `/games/mines/state`, `start`, `reveal`, `cashout` | `bet, mines` puis `tile` |
| GET/POST | `/games/bj/state`, `deal`, `hit`, `stand`, `double` | `bet` pour `deal`    |
| GET/POST | `/games/crash/state`, `launch`, `cashout`, `wait?round=` | `bet, auto?`    |

Chaque réponse de jeu contient `stake`, `payout`, `net` et `wallet` (le solde et les statistiques à jour).
