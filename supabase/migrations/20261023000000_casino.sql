-- Schéma privé : il n'est pas exposé par l'API REST de Supabase.
-- Seule la fonction Edge « api » y accède, via la connexion directe à Postgres.
create schema if not exists casino;
revoke all on schema casino from public, anon, authenticated;

create table casino.users (
  id           bigint generated always as identity primary key,
  username     text unique,
  pass_hash    text,
  display_name text not null,
  is_guest     boolean not null default false,
  balance      bigint not null default 100000 check (balance >= 0), -- en centimes : 1 000 jetons
  wagered      bigint not null default 0,
  won          bigint not null default 0,
  played       integer not null default 0,
  best         bigint not null default 0,
  sound        boolean not null default true,
  favs         jsonb not null default '["slots"]',
  bets         jsonb not null default '{}',
  created_at   bigint not null
);
create unique index users_username_ci on casino.users (lower(username));

create table casino.sessions (
  token      text primary key,
  user_id    bigint not null references casino.users(id) on delete cascade,
  created_at bigint not null,
  expires_at bigint not null
);
create index sessions_user on casino.sessions (user_id);

create table casino.transactions (
  id         bigint generated always as identity primary key,
  user_id    bigint not null references casino.users(id) on delete cascade,
  kind       text not null,          -- game | deposit | reset
  game       text not null,
  stake      bigint not null default 0,
  payout     bigint not null default 0,
  net        bigint not null default 0,
  details    jsonb,
  created_at bigint not null
);
create index tx_user on casino.transactions (user_id, id desc);
create index tx_game on casino.transactions (game, id desc);
create index tx_user_game on casino.transactions (user_id, game, id desc);

create table casino.active_rounds (
  id         bigint generated always as identity primary key,
  user_id    bigint not null references casino.users(id) on delete cascade,
  game       text not null,
  stake      bigint not null,
  state      jsonb not null,
  created_at bigint not null,
  unique (user_id, game)
);
create index active_rounds_game on casino.active_rounds (game);

create table casino.login_failures (
  ip text primary key,
  n  integer not null,
  t  bigint not null
);

alter table casino.users enable row level security;
alter table casino.sessions enable row level security;
alter table casino.transactions enable row level security;
alter table casino.active_rounds enable row level security;
alter table casino.login_failures enable row level security;
