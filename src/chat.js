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

// Canaux autorisés : global + n'importe quelle ville/région (string libre)
function sanitizeChannel(ch) {
  if (!ch || typeof ch !== 'string') return null;
  const trimmed = ch.trim().slice(0, 50);
  if (!trimmed) return null;
  return trimmed;
}

// GET /chat/:channel — 50 derniers messages
router.get('/:channel', authMiddleware, async (req, res) => {
  const channel = sanitizeChannel(req.params.channel);
  if (!channel) return res.status(400).json({ error: 'Canal invalide' });
  try {
    const result = await pool.query(
      `SELECT m.id, m.text, m.created_at, u.username
       FROM messages m
       JOIN users u ON u.id = m.user_id
       WHERE m.channel = $1
       ORDER BY m.created_at DESC
       LIMIT 50`,
      [channel]
    );
    res.json({ messages: result.rows.reverse() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /chat/:channel — envoyer un message
router.post('/:channel', authMiddleware, async (req, res) => {
  const channel = sanitizeChannel(req.params.channel);
  const { text } = req.body;
  const userId = req.user.userId;

  if (!channel) return res.status(400).json({ error: 'Canal invalide' });
  if (!text || !text.trim()) return res.status(400).json({ error: 'Message vide' });
  if (text.trim().length > 300) return res.status(400).json({ error: 'Message trop long' });

  try {
    const userRow = await pool.query('SELECT username FROM users WHERE id = $1', [userId]);
    const username = userRow.rows[0]?.username;
    if (!username) return res.status(404).json({ error: 'Utilisateur introuvable' });

    const result = await pool.query(
      `INSERT INTO messages (user_id, channel, text) VALUES ($1, $2, $3)
       RETURNING id, text, created_at`,
      [userId, channel, text.trim()]
    );
    const msg = { ...result.rows[0], username };

    // Broadcast via socket.io
    const io = req.app.get('io');
    if (io) io.to(`chat_${channel}`).emit('new_message', msg);

    res.json({ success: true, message: msg });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
