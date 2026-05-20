const express = require('express');
const jwt = require('jsonwebtoken');
const turf = require('@turf/turf');
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

function toTurfPolygon(coordinates) {
  const ring = [...coordinates, coordinates[0]];
  return turf.polygon([ring.map(c => [c.longitude, c.latitude])]);
}

router.post('/save', authMiddleware, async (req, res) => {
  const { distance_m, duration_s, points, coordinates, area_m2 } = req.body;
  const userId = req.user.userId;

  try {
    const run = await pool.query(
      'INSERT INTO runs (user_id, distance_m, duration_s, points) VALUES ($1, $2, $3, $4) RETURNING id',
      [userId, distance_m, duration_s, points]
    );

    const stolen = [];

    if (coordinates && coordinates.length >= 3 && area_m2 > 0) {
      let finalCoords = coordinates;
      let finalArea = area_m2;
      let finalPoints = points;

      // Fusionner avec les territoires existants du même joueur qui se chevauchent
      const ownTerritories = await pool.query(
        'SELECT id, coordinates, area_m2, points FROM territories WHERE user_id = $1',
        [userId]
      );

      const toDelete = [];
      let merged = toTurfPolygon(coordinates);

      for (const t of ownTerritories.rows) {
        try {
          const existing = toTurfPolygon(t.coordinates);
          if (turf.booleanOverlap(merged, existing) || turf.booleanContains(merged, existing) || turf.booleanContains(existing, merged)) {
            const union = turf.union(turf.featureCollection([merged, existing]));
            if (union && union.geometry.type === 'Polygon') {
              merged = union;
              finalArea += t.area_m2;
              finalPoints += t.points;
              toDelete.push(t.id);
            }
          }
        } catch {}
      }

      finalCoords = merged.geometry.coordinates[0].map(c => ({ latitude: c[1], longitude: c[0] }));

      for (const id of toDelete) {
        await pool.query('DELETE FROM territories WHERE id = $1', [id]);
      }

      await pool.query(
        'INSERT INTO territories (user_id, coordinates, area_m2, points) VALUES ($1, $2, $3, $4)',
        [userId, JSON.stringify(finalCoords), finalArea, finalPoints]
      );

      const newPoly = toTurfPolygon(finalCoords);

      const others = await pool.query(
        'SELECT id, user_id, coordinates, points FROM territories WHERE user_id != $1',
        [userId]
      );

      for (const t of others.rows) {
        try {
          const oldPoly = toTurfPolygon(t.coordinates);
          const centroid = turf.centroid(oldPoly);
          if (turf.booleanPointInPolygon(centroid, newPoly)) {
            await pool.query('UPDATE territories SET user_id = $1 WHERE id = $2', [userId, t.id]);
            await pool.query('UPDATE users SET points = GREATEST(0, points - $1) WHERE id = $2', [t.points, t.user_id]);
            await pool.query('UPDATE users SET points = points + $1 WHERE id = $2', [t.points, userId]);
            stolen.push({ territoryId: t.id, fromUserId: t.user_id, points: t.points });
          }
        } catch {}
      }
    }

    await pool.query('UPDATE users SET points = points + $1 WHERE id = $2', [points, userId]);

    res.json({ success: true, runId: run.rows[0].id, stolen });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.get('/me', authMiddleware, async (req, res) => {
  const userId = req.user.userId;
  try {
    const territories = await pool.query(
      'SELECT id, coordinates, area_m2, points, created_at FROM territories WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    const stats = await pool.query(
      'SELECT COUNT(*) as runs, SUM(distance_m) as total_distance, SUM(points) as total_points FROM runs WHERE user_id = $1',
      [userId]
    );
    res.json({ territories: territories.rows, stats: stats.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.get('/all', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.id, t.user_id, t.coordinates, t.area_m2, t.points, u.username
       FROM territories t
       JOIN users u ON u.id = t.user_id
       ORDER BY t.created_at DESC`
    );
    res.json({ territories: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
