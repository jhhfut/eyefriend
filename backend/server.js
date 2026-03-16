import express from 'express';
import cors from 'cors';
import { Firestore, FieldValue } from '@google-cloud/firestore';

const app = express();
const PORT = process.env.PORT || 8080;

// Firestore client — automatically uses Application Default Credentials on Cloud Run
const db = new Firestore({
  projectId: process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT,
});

app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json());

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'be-my-ai-backend' });
});

// ─── Sessions ─────────────────────────────────────────────────────────────────

// POST /api/sessions — create a new vision assistant session
app.post('/api/sessions', async (req, res) => {
  try {
    const { mode = 'explore' } = req.body;
    const session = {
      mode,
      startedAt: FieldValue.serverTimestamp(),
      endedAt: null,
      status: 'active',
      alertsCount: 0,
      textReadCount: 0,
    };
    const ref = await db.collection('sessions').add(session);
    res.status(201).json({ id: ref.id, ...session, startedAt: new Date().toISOString() });
  } catch (err) {
    console.error('POST /api/sessions error:', err);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// GET /api/sessions — list recent sessions
app.get('/api/sessions', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const snapshot = await db.collection('sessions')
      .orderBy('startedAt', 'desc')
      .limit(limit)
      .get();
    const sessions = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      startedAt: doc.data().startedAt?.toDate?.()?.toISOString?.() ?? null,
      endedAt: doc.data().endedAt?.toDate?.()?.toISOString?.() ?? null,
    }));
    res.json(sessions);
  } catch (err) {
    console.error('GET /api/sessions error:', err);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

// GET /api/sessions/:id — get a single session
app.get('/api/sessions/:id', async (req, res) => {
  try {
    const doc = await db.collection('sessions').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Session not found' });
    const data = doc.data();
    res.json({
      id: doc.id,
      ...data,
      startedAt: data.startedAt?.toDate?.()?.toISOString?.() ?? null,
      endedAt: data.endedAt?.toDate?.()?.toISOString?.() ?? null,
    });
  } catch (err) {
    console.error('GET /api/sessions/:id error:', err);
    res.status(500).json({ error: 'Failed to get session' });
  }
});

// PUT /api/sessions/:id — update session (end, increment counters, etc.)
app.put('/api/sessions/:id', async (req, res) => {
  try {
    const { status, incrementAlert, incrementTextRead } = req.body;
    const update = { updatedAt: FieldValue.serverTimestamp() };

    if (status === 'ended') {
      update.status = 'ended';
      update.endedAt = FieldValue.serverTimestamp();
    }
    if (incrementAlert) {
      update.alertsCount = FieldValue.increment(1);
    }
    if (incrementTextRead) {
      update.textReadCount = FieldValue.increment(1);
    }

    await db.collection('sessions').doc(req.params.id).update(update);
    res.json({ success: true });
  } catch (err) {
    console.error('PUT /api/sessions/:id error:', err);
    res.status(500).json({ error: 'Failed to update session' });
  }
});

// DELETE /api/sessions/:id — delete a session
app.delete('/api/sessions/:id', async (req, res) => {
  try {
    await db.collection('sessions').doc(req.params.id).delete();
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/sessions/:id error:', err);
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

// ─── Analytics ────────────────────────────────────────────────────────────────

// GET /api/analytics — aggregate stats
app.get('/api/analytics', async (req, res) => {
  try {
    const snapshot = await db.collection('sessions').get();
    const sessions = snapshot.docs.map(d => d.data());

    const total = sessions.length;
    const completed = sessions.filter(s => s.status === 'ended').length;
    const totalAlerts = sessions.reduce((sum, s) => sum + (s.alertsCount || 0), 0);
    const totalTextReads = sessions.reduce((sum, s) => sum + (s.textReadCount || 0), 0);

    // Mode distribution
    const modeCounts = {};
    sessions.forEach(s => {
      const m = s.mode || 'explore';
      modeCounts[m] = (modeCounts[m] || 0) + 1;
    });
    const modeDistribution = Object.entries(modeCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([mode, count]) => ({ mode, count }));

    res.json({
      totalSessions: total,
      completedSessions: completed,
      totalAlerts,
      totalTextReads,
      modeDistribution,
    });
  } catch (err) {
    console.error('GET /api/analytics error:', err);
    res.status(500).json({ error: 'Failed to get analytics' });
  }
});

app.listen(PORT, () => {
  console.log(`Be My AI backend running on port ${PORT}`);
  console.log(`Project: ${process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || 'local'}`);
});
