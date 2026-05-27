const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('./db');

const router = express.Router();

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'Token manquant' });
  try {
    const token = header.replace('Bearer ', '');
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token invalide' });
  }
}

router.get('/', authMiddleware, async (req, res) => {
  const userId = req.user.userId;
  const type = req.query.type || 'monthly'; // 'monthly' | 'weekly'

  const scoreCol = type === 'weekly' ? 'weekly_territory_points' : 'monthly_points';

  try {
    const result = await pool.query(
      `SELECT id, username, ${scoreCol} as points FROM users ORDER BY ${scoreCol} DESC LIMIT 50`
    );

    const players = result.rows.map((u, i) => ({
      rank: i + 1,
      id: u.id,
      username: u.username,
      points: u.points,
    }));

    const myIndex = players.findIndex(p => p.id === userId);
    let me = null;
    if (myIndex !== -1) {
      me = players[myIndex];
    } else {
      const myRow = await pool.query(
        `SELECT id, username, ${scoreCol} as points FROM users WHERE id = $1`, [userId]
      );
      if (myRow.rows.length > 0) {
        const countAbove = await pool.query(
          `SELECT COUNT(*) FROM users WHERE ${scoreCol} > $1`, [myRow.rows[0].points]
        );
        me = {
          rank: parseInt(countAbove.rows[0].count) + 1,
          id: myRow.rows[0].id,
          username: myRow.rows[0].username,
          points: myRow.rows[0].points,
        };
      }
    }

    res.json({ players, me, type });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
