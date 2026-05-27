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

const SKIN_INFO = {
  steel: { label: 'Gris Acier', color: '#94a3b8' }, white:    { label: 'Blanc Pur',    color: '#e2e8f0' },
  ember: { label: 'Ember',      color: '#f97316' }, lime:     { label: 'Lime',         color: '#4ade80' },
  sol:   { label: 'Soleil',     color: '#fbbf24' }, rouge:    { label: 'Rouge',        color: '#f43f5e' },
  dots:  { label: 'Pointillé',  color: '#60a5fa' }, lavender: { label: 'Lavande',      color: '#a78bfa' },
  ocean: { label: 'Ocean',      color: '#22d3ee' }, fire:     { label: 'Feu',          color: '#f97316' },
  aurora:{ label: 'Aurora',     color: '#10b981' }, sunset:   { label: 'Sunset',       color: '#ec4899' },
  ghost: { label: 'Ghost',      color: '#f8fafc' }, lava:     { label: 'Lava',         color: '#ef4444' },
  pulse: { label: 'Pulse',      color: '#3b82f6' }, prism:    { label: 'Prisme',       color: '#c084fc' },
  lightning: { label: 'Lightning', color: '#fbbf24' }, rainbow: { label: 'Arc-en-ciel', color: '#818cf8' },
  tron:  { label: 'Tron',       color: '#38bdf8' }, phoenix:  { label: 'Phoenix',      color: '#f97316' },
};

function skinReward(id) {
  const info = SKIN_INFO[id] || { label: id, color: '#888' };
  return { type: 'skin', skin: id, label: info.label, color: info.color };
}

const INVASION_PALIERS = [
  { palier: 1, threshold: 2,  reward: { type: 'shield', shield: '24h', label: 'Bouclier 24h' } },
  { palier: 2, threshold: 6,  reward: { type: 'shield', shield: '48h', label: 'Bouclier 48h' } },
  { palier: 3, threshold: 10, reward: { type: 'shield', shield: '72h', label: 'Bouclier 72h' } },
];

function buildPaliers(u) {
  return {
    territoire: [
      { palier: 1, threshold: 2000,  reward: skinReward(u.vault_skin_tc) },
      { palier: 2, threshold: 3500,  reward: skinReward(u.vault_skin_tr) },
      { palier: 3, threshold: 6500,  reward: skinReward(u.vault_skin_te) },
    ],
    invasion: INVASION_PALIERS,
    endurance: [
      { palier: 1, threshold: 5000,  reward: skinReward(u.vault_skin_ec) },
      { palier: 2, threshold: 15000, reward: skinReward(u.vault_skin_er) },
      { palier: 3, threshold: 30000, reward: skinReward(u.vault_skin_ee) },
    ],
  };
}

const SHIELD_MAX = { '24h': 3, '48h': 2, '72h': 1 };

router.get('/progress', authMiddleware, async (req, res) => {
  const userId = req.user.userId;
  try {
    const result = await pool.query(
      `SELECT weekly_territory_points, weekly_stolen_count, weekly_distance_m,
              vault_snapshot_territoire, vault_snapshot_invasion, vault_snapshot_endurance,
              weekly_claimed_territoire, weekly_claimed_invasion, weekly_claimed_endurance,
              vault_choice_made, vault_revealed, skins, shield_24h, shield_48h, shield_72h,
              vault_skin_tc, vault_skin_tr, vault_skin_te, vault_skin_ec, vault_skin_er, vault_skin_ee
       FROM users WHERE id = $1`,
      [userId]
    );
    const u = result.rows[0];
    const PALIERS = buildPaliers(u);
    const vaultRevealed = u.vault_revealed || false;

    // Paliers débloqués basés sur le SNAPSHOT (pas les stats courantes)
    const unlockedSlots = [];
    if (vaultRevealed) {
      for (const [cat, tiers] of Object.entries(PALIERS)) {
        const snapVal = cat === 'territoire' ? u.vault_snapshot_territoire
                      : cat === 'invasion'   ? u.vault_snapshot_invasion
                      : u.vault_snapshot_endurance;
        const claimed = cat === 'territoire' ? u.weekly_claimed_territoire
                      : cat === 'invasion'   ? u.weekly_claimed_invasion
                      : u.weekly_claimed_endurance;
        for (const tier of tiers) {
          if ((snapVal || 0) >= tier.threshold && (claimed || 0) < tier.palier) {
            unlockedSlots.push({ category: cat, palier: tier.palier, reward: tier.reward });
          }
        }
      }
    }

    res.json({
      // Stats courantes = progression de la semaine en cours (toujours visible)
      territoire: { value: u.weekly_territory_points || 0, claimed: u.weekly_claimed_territoire || 0 },
      invasion:   { value: u.weekly_stolen_count || 0,     claimed: u.weekly_claimed_invasion || 0 },
      endurance:  { value: u.weekly_distance_m || 0,       claimed: u.weekly_claimed_endurance || 0 },
      // Snapshot = ce sur quoi les récompenses sont basées
      snapshot: {
        territoire: u.vault_snapshot_territoire || 0,
        invasion:   u.vault_snapshot_invasion || 0,
        endurance:  u.vault_snapshot_endurance || 0,
      },
      unlockedSlots,
      vaultChoiceMade: u.vault_choice_made || false,
      vaultRevealed,
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

  const userRow = await pool.query(
    `SELECT vault_skin_tc, vault_skin_tr, vault_skin_te, vault_skin_ec, vault_skin_er, vault_skin_ee FROM users WHERE id = $1`, [userId]
  );
  const PALIERS = buildPaliers(userRow.rows[0]);
  if (!PALIERS[category]) return res.status(400).json({ error: 'Catégorie invalide' });
  const tier = PALIERS[category].find(p => p.palier === palier);
  if (!tier) return res.status(400).json({ error: 'Palier invalide' });

  const claimedCol = `weekly_claimed_${category}`;
  const snapshotCol = category === 'territoire' ? 'vault_snapshot_territoire'
                    : category === 'invasion'   ? 'vault_snapshot_invasion'
                    : 'vault_snapshot_endurance';

  try {
    const result = await pool.query(
      `SELECT ${snapshotCol}, ${claimedCol}, vault_choice_made, vault_revealed,
              shield_24h, shield_48h, shield_72h FROM users WHERE id = $1`, [userId]
    );
    const u = result.rows[0];

    if (!u.vault_revealed) return res.status(400).json({ error: 'Le vault s\'ouvre le dimanche' });
    if (u.vault_choice_made) return res.status(400).json({ error: 'Tu as déjà choisi ta récompense cette semaine' });
    if ((u[snapshotCol] || 0) < tier.threshold) return res.status(400).json({ error: 'Palier non atteint' });
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
