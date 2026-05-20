const express = require('express');
const cors = require('cors');
require('dotenv').config();

const authRouter = require('./auth');
const runsRouter = require('./runs');
const leaderboardRouter = require('./leaderboard');
const pool = require('./db');

const app = express();

app.use(cors());
app.use(express.json());

app.use('/auth', authRouter);
app.use('/runs', runsRouter);
app.use('/leaderboard', leaderboardRouter);

app.get('/health', (_, res) => res.json({ status: 'ok' }));

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
  console.log('Table users prête');

  app.listen(PORT, () => console.log(`ZON:R backend → http://localhost:${PORT}`));
}

start().catch(console.error);
