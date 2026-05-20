const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('./db');

const router = express.Router();

const SHIELD_HOURS = { '24h': 24, '48h': 48, '72h': 72 };

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

// Activer un bouclier sur un territoire
router.post('/apply', authMiddleware, async (req, res) => {
  const { territoryId, shieldType } = req.body;
  const userId = req.user.userId;

  if (!SHIELD_HOURS[shieldType]) return res.status(400).json({ error: 'Type de bouclier invalide' });

  try {
    const col = `shield_${shieldType}`;

    const user = await pool.query(`SELECT ${col} FROM users WHERE id = $1`, [userId]);
    if (!user.rows.length || user.rows[0][col] <= 0) {
      return res.status(400).json({ error: 'Pas de bouclier disponible' });
    }

    const territory = await pool.query('SELECT id FROM territories WHERE id = $1 AND user_id = $2', [territoryId, userId]);
    if (!territory.rows.length) return res.status(403).json({ error: 'Territoire introuvable' });

    const expiresAt = new Date(Date.now() + SHIELD_HOURS[shieldType] * 3600 * 1000);

    await pool.query(`UPDATE users SET ${col} = ${col} - 1 WHERE id = $1`, [userId]);
    await pool.query(
      'UPDATE territories SET shield_type = $1, shield_expires_at = $2 WHERE id = $3',
      [shieldType, expiresAt, territoryId]
    );

    res.json({ success: true, expiresAt });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Inventaire de boucliers
router.get('/inventory', authMiddleware, async (req, res) => {
  const userId = req.user.userId;
  try {
    const result = await pool.query(
      'SELECT shield_24h, shield_48h, shield_72h FROM users WHERE id = $1',
      [userId]
    );
    res.json(result.rows[0] || { shield_24h: 0, shield_48h: 0, shield_72h: 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
