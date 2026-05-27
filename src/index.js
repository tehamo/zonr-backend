const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const cron = require('node-cron');
const authRouter = require('./auth');
const runsRouter = require('./runs');
const leaderboardRouter = require('./leaderboard');
const shieldsRouter = require('./shields');
const vaultRouter = require('./vault');
const pool = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

app.use('/auth', authRouter);
app.use('/runs', runsRouter);
app.use('/leaderboard', leaderboardRouter);
app.use('/shields', shieldsRouter);
app.use('/vault', vaultRouter);

app.get('/health', (_, res) => res.json({ status: 'ok' }));

io.on('connection', (socket) => {
  socket.on('join', (token) => {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.join(`user_${decoded.userId}`);
    } catch {}
  });
});

// Exporter io pour l'utiliser dans les routes
app.set('io', io);

const PORT = process.env.PORT || 3000;

const COMMON_SKINS = ['steel','white','ember','lime','sol','rouge','dots','lavender'];
const RARE_SKINS   = ['ocean','fire','aurora','sunset','ghost','lava','pulse'];
const EPIC_SKINS   = ['prism','lightning','rainbow','tron','phoenix'];

function pickRandomSkins() {
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  const pickDiff = (arr, exclude) => {
    let s; do { s = pick(arr); } while (s === exclude); return s;
  };
  const tc = pick(COMMON_SKINS); // territoire commun
  const tr = pick(RARE_SKINS);   // territoire rare
  const te = pick(EPIC_SKINS);   // territoire épique
  return {
    vault_skin_tc: tc,
    vault_skin_tr: tr,
    vault_skin_te: te,
    vault_skin_ec: pickDiff(COMMON_SKINS, tc), // endurance commun ≠ territoire commun
    vault_skin_er: pickDiff(RARE_SKINS, tr),   // endurance rare ≠ territoire rare
    vault_skin_ee: pick(EPIC_SKINS),           // endurance épique (5 skins, peut répéter)
  };
}

async function start() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(30) UNIQUE NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      points INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS territories (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      coordinates JSONB NOT NULL,
      area_m2 FLOAT NOT NULL,
      points INTEGER NOT NULL,
      shield_type VARCHAR(5),
      shield_expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS runs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      distance_m FLOAT,
      duration_s INTEGER,
      points INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS shield_24h INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS shield_48h INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS shield_72h INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE territories ADD COLUMN IF NOT EXISTS shield_type VARCHAR(5)`);
  await pool.query(`ALTER TABLE territories ADD COLUMN IF NOT EXISTS shield_expires_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS weekly_territory_points INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS weekly_stolen_count INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS weekly_distance_m INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS weekly_claimed_territoire INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS weekly_claimed_invasion INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS weekly_claimed_endurance INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS skins TEXT[] DEFAULT '{}'`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS vault_choice_made BOOLEAN DEFAULT false`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS active_skin VARCHAR(20) DEFAULT NULL`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS monthly_points INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS vault_snapshot_territoire INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS vault_snapshot_invasion INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS vault_snapshot_endurance INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS vault_revealed BOOLEAN DEFAULT false`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS vault_skin_tc VARCHAR(20) DEFAULT 'steel'`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS vault_skin_tr VARCHAR(20) DEFAULT 'ocean'`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS vault_skin_te VARCHAR(20) DEFAULT 'prism'`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS vault_skin_ec VARCHAR(20) DEFAULT 'lime'`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS vault_skin_er VARCHAR(20) DEFAULT 'aurora'`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS vault_skin_ee VARCHAR(20) DEFAULT 'lightning'`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS push_token TEXT DEFAULT NULL`);
  // Générer des skins aléatoires pour les joueurs existants (colonnes à valeur par défaut)
  const existingUsers = await pool.query(`SELECT id FROM users WHERE vault_skin_tc = 'steel'`);
  for (const u of existingUsers.rows) {
    const s = pickRandomSkins();
    await pool.query(`UPDATE users SET vault_skin_tc=$1, vault_skin_tr=$2, vault_skin_te=$3,
      vault_skin_ec=$4, vault_skin_er=$5, vault_skin_ee=$6 WHERE id=$7`,
      [s.vault_skin_tc, s.vault_skin_tr, s.vault_skin_te, s.vault_skin_ec, s.vault_skin_er, s.vault_skin_ee, u.id]);
  }

  // Backfill : si monthly_points est 0 mais points > 0, on synchronise
  await pool.query(`UPDATE users SET monthly_points = points WHERE monthly_points = 0 AND points > 0`);
  console.log('Table users prête');

  // Reset vault chaque dimanche à 3h
  cron.schedule('0 3 * * 0', async () => {
    // 1. Snapshot des stats + révélation vault
    await pool.query(`UPDATE users SET
      vault_snapshot_territoire = weekly_territory_points,
      vault_snapshot_invasion = weekly_stolen_count,
      vault_snapshot_endurance = weekly_distance_m,
      vault_revealed = true,
      vault_choice_made = false,
      weekly_claimed_territoire = 0,
      weekly_claimed_invasion = 0,
      weekly_claimed_endurance = 0
    `);
    // 2. Reset des stats hebdo
    await pool.query(`UPDATE users SET
      weekly_territory_points = 0,
      weekly_stolen_count = 0,
      weekly_distance_m = 0
    `);
    // 3. Nouveaux skins aléatoires par joueur pour la semaine suivante
    const users = await pool.query('SELECT id FROM users');
    for (const u of users.rows) {
      const s = pickRandomSkins();
      await pool.query(`UPDATE users SET vault_skin_tc=$1, vault_skin_tr=$2, vault_skin_te=$3,
        vault_skin_ec=$4, vault_skin_er=$5, vault_skin_ee=$6 WHERE id=$7`,
        [s.vault_skin_tc, s.vault_skin_tr, s.vault_skin_te, s.vault_skin_ec, s.vault_skin_er, s.vault_skin_ee, u.id]);
    }
    console.log(`[VAULT] Reset + ${users.rows.length} tirages aléatoires effectués`);
  }, { timezone: 'Europe/Paris' });

  // Reset classement mensuel le 1er du mois à 3h
  cron.schedule('0 3 1 * *', async () => {
    await pool.query(`UPDATE users SET monthly_points = 0`);
    console.log('[LEADERBOARD] Reset mensuel effectué');
  }, { timezone: 'Europe/Paris' });

  server.listen(PORT, () => console.log(`ZON:R backend → http://localhost:${PORT}`));
}

start().catch(console.error);
