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
  console.log('Table users prête');

  // Reset vault chaque dimanche à 3h
  cron.schedule('0 3 * * 0', async () => {
    await pool.query(`UPDATE users SET
      weekly_territory_points = 0,
      weekly_stolen_count = 0,
      weekly_distance_m = 0,
      weekly_claimed_territoire = 0,
      weekly_claimed_invasion = 0,
      weekly_claimed_endurance = 0,
      vault_choice_made = false
    `);
    console.log('[VAULT] Reset hebdomadaire effectué');
  }, { timezone: 'Europe/Paris' });

  server.listen(PORT, () => console.log(`ZON:R backend → http://localhost:${PORT}`));
}

start().catch(console.error);
