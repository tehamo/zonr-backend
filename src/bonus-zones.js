const express = require('express');
const pool = require('./db');
const turf = require('@turf/turf');

const router = express.Router();

const TARGET_ACTIVE = 5;
const ZONE_DURATION_H = 24;
const ZONE_RADIUS_M = 150;
const ZONE_MULTIPLIER = 2.0;

async function spawnIfNeeded() {
  const { rows: [{ count }] } = await pool.query(
    "SELECT COUNT(*) FROM bonus_zones WHERE expires_at > NOW()"
  );
  const needed = TARGET_ACTIVE - parseInt(count);
  if (needed <= 0) return;

  const { rows: territories } = await pool.query(
    'SELECT coordinates FROM territories ORDER BY RANDOM() LIMIT $1',
    [needed * 2]
  );
  if (territories.length === 0) return;

  const toSpawn = territories.slice(0, needed);
  const expiresAt = new Date(Date.now() + ZONE_DURATION_H * 3600000);

  for (const t of toSpawn) {
    try {
      const coords = t.coordinates;
      const ring = [...coords, coords[0]].map(c => [c.longitude, c.latitude]);
      const centroid = turf.centroid(turf.polygon([ring]));
      const [baseLon, baseLat] = centroid.geometry.coordinates;

      // Offset aléatoire entre 50 et 300m autour du centroïde du territoire
      const offsetM = 50 + Math.random() * 250;
      const angle = Math.random() * 2 * Math.PI;
      const dLat = (offsetM * Math.cos(angle)) / 111320;
      const dLon = (offsetM * Math.sin(angle)) / (111320 * Math.cos((baseLat * Math.PI) / 180));

      await pool.query(
        'INSERT INTO bonus_zones (latitude, longitude, radius_m, multiplier, expires_at) VALUES ($1, $2, $3, $4, $5)',
        [baseLat + dLat, baseLon + dLon, ZONE_RADIUS_M, ZONE_MULTIPLIER, expiresAt]
      );
    } catch {}
  }
}

// Vérifie si un polygone Turf contient une zone bonus active → retourne le multiplicateur le plus élevé trouvé
async function getMultiplierForPolygon(turfPolygon) {
  const { rows } = await pool.query(
    "SELECT latitude, longitude, multiplier FROM bonus_zones WHERE expires_at > NOW()"
  );
  let best = 1.0;
  for (const z of rows) {
    const pt = turf.point([z.longitude, z.latitude]);
    if (turf.booleanPointInPolygon(pt, turfPolygon)) {
      best = Math.max(best, parseFloat(z.multiplier));
    }
  }
  return best;
}

router.get('/', async (req, res) => {
  try {
    await spawnIfNeeded();
    const { rows } = await pool.query(
      "SELECT id, latitude, longitude, radius_m, multiplier, expires_at FROM bonus_zones WHERE expires_at > NOW() ORDER BY created_at DESC"
    );
    res.json({ zones: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = { router, getMultiplierForPolygon };
