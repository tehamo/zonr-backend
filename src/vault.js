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

const PALIERS = {
  territoire: [
    { palier: 1, threshold: 2000, reward: { type: 'skin', skin: 'steel',   label: 'Gris Acier',  color: '#94a3b8' } },
    { palier: 2, threshold: 3500, reward: { type: 'skin', skin: 'ember',   label: 'Ember',       color: '#f97316' } },
    { palier: 3, threshold: 6500, reward: { type: 'skin', skin: 'ocean',   label: 'Ocean',       color: '#22d3ee' } },
  ],
  invasion: [
    { palier: 1, threshold: 2,  reward: { type: 'shield', shield: '24h', label: 'Bouclier 24h' } },
    { palier: 2, threshold: 6,  reward: { type: 'shield', shield: '48h', label: 'Bouclier 48h' } },
    { palier: 3, threshold: 10, reward: { type: 'shield', shield: '72h', label: 'Bouclier 72h' } },
  ],
  endurance: [
    { palier: 1, threshold: 5000,  reward: { type: 'skin', skin: 'lime',    label: 'Lime',    color: '#4ade80' } },
    { palier: 2, threshold: 15000, reward: { type: 'skin', skin: 'lavender',label: 'Lavande', color: '#a78bfa' } },
    { palier: 3, threshold: 30000, reward: { type: 'skin', skin: 'aurora',  label: 'Aurora',  color: '#10b981' } },
  ],
};

const SHIELD_MAX = { '24h': 3, '48h': 2, '72h': 1 };

router.get('/progress', authMiddleware, async (req, res) => {
  const userId = req.user.userId;
  try {
    const result = await pool.query(
      `SELECT weekly_territory_points, weekly_stolen_count, weekly_distance_m,
              weekly_claimed_territoire, weekly_claimed_invasion, weekly_claimed_endurance,
              vault_choice_made, skins, shield_24h, shield_48h, shield_72h FROM users WHERE id = $1`,
      [userId]
    );
    const u = result.rows[0];

    // Calculer tous les paliers débloqués mais non encore choisis
    const unlockedSlots = [];
    for (const [cat, tiers] of Object.entries(PALIERS)) {
      const statVal = cat === 'territoire' ? u.weekly_territory_points
                    : cat === 'invasion'   ? u.weekly_stolen_count
                    : u.weekly_distance_m;
      const claimed = cat === 'territoire' ? u.weekly_claimed_territoire
                    : cat === 'invasion'   ? u.weekly_claimed_invasion
                    : u.weekly_claimed_endurance;
      for (const tier of tiers) {
        if ((statVal || 0) >= tier.threshold && (claimed || 0) < tier.palier) {
          unlockedSlots.push({ category: cat, palier: tier.palier, reward: tier.reward });
        }
      }
    }

    res.json({
      territoire: { value: u.weekly_territory_points || 0, claimed: u.weekly_claimed_territoire || 0 },
      invasion:   { value: u.weekly_stolen_count || 0,     claimed: u.weekly_claimed_invasion || 0 },
      endurance:  { value: u.weekly_distance_m || 0,       claimed: u.weekly_claimed_endurance || 0 },
      unlockedSlots,
      vaultChoiceMade: u.vault_choice_made || false,
      skins: u.skins || [],
      paliers: PALIERS,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Choisir UNE récompense parmi les slots débloqués
router.post('/claim', authMiddleware, async (req, res) => {
  const { category, palier } = req.body;
  const userId = req.user.userId;

  if (!PALIERS[category]) return res.status(400).json({ error: 'Catégorie invalide' });
  const tier = PALIERS[category].find(p => p.palier === palier);
  if (!tier) return res.status(400).json({ error: 'Palier invalide' });

  const claimedCol = `weekly_claimed_${category}`;
  const statCol = category === 'territoire' ? 'weekly_territory_points'
                : category === 'invasion'   ? 'weekly_stolen_count'
                : 'weekly_distance_m';

  try {
    const result = await pool.query(
      `SELECT ${statCol}, ${claimedCol}, vault_choice_made,
              shield_24h, shield_48h, shield_72h FROM users WHERE id = $1`, [userId]
    );
    const u = result.rows[0];

    if (u.vault_choice_made) return res.status(400).json({ error: 'Tu as déjà choisi ta récompense cette semaine' });
    if ((u[statCol] || 0) < tier.threshold) return res.status(400).json({ error: 'Palier non atteint' });
    if ((u[claimedCol] || 0) >= palier) return res.status(400).json({ error: 'Déjà réclamé' });

    const { reward } = tier;

    if (reward.type === 'shield') {
      const col = `shield_${reward.shield}`;
      const current = u[col] || 0;
      const max = SHIELD_MAX[reward.shield];

      if (current >= max) {
        // Stock plein → activation immédiate sur le premier territoire du joueur
        const territory = await pool.query(
          'SELECT id FROM territories WHERE user_id = $1 LIMIT 1', [userId]
        );
        if (territory.rows.length > 0) {
          const expiresAt = new Date(Date.now() + parseInt(reward.shield) * 3600000);
          await pool.query(
            'UPDATE territories SET shield_type = $1, shield_expires_at = $2 WHERE id = $3',
            [reward.shield, expiresAt, territory.rows[0].id]
          );
        }
      } else {
        await pool.query(`UPDATE users SET ${col} = ${col} + 1 WHERE id = $1`, [userId]);
      }
    } else if (reward.type === 'skin') {
      await pool.query(
        `UPDATE users SET skins = array_append(skins, $1) WHERE id = $2`,
        [reward.skin, userId]
      );
    }

    await pool.query(
      `UPDATE users SET ${claimedCol} = $1, vault_choice_made = true WHERE id = $2`,
      [palier, userId]
    );

    res.json({ success: true, reward });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});



router.post('/activate-skin', authMiddleware, async (req, res) => {
  const { skin } = req.body;
  const userId = req.user.userId;
  try {
    const result = await pool.query('SELECT skins FROM users WHERE id = $1', [userId]);
    const skins = result.rows[0]?.skins || [];
    if (!skins.includes(skin)) return res.status(400).json({ error: 'Skin non possédé' });
    await pool.query('UPDATE users SET active_skin = $1 WHERE id = $2', [skin, userId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
module.exports.PALIERS = PALIERS;
