'use strict';
const { open } = require('./db');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT) || 3000;
const db = open();
const app = createApp(db, { secureCookies: process.env.SECURE_COOKIES === '1' });
const server = app.listen(PORT, () => console.log(`Maison d’Or : http://localhost:${PORT}`));

const stop = () => server.close(() => { db.close(); process.exit(0); });
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
