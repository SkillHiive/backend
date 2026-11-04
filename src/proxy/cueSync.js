/**
 * Cue Sync Proxy for SkillHive Backend
 * Proxies Cue push/pull requests to Backstage
 */

const { createClient } = require('@supabase/supabase-js');
const { logger } = require('../logger');

const BACKSTAGE_URL = process.env.BACKSTAGE_URL || 'http://localhost:7420';
const BACKSTAGE_TOKEN = process.env.BACKSTAGE_TOKEN;

async function validateSession(supabase, token) {
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

async function setupCueSyncProxy(app, supabase) {
  app.post('/v1/cue/push', async (req, res) => {
    const requestId = crypto.randomUUID();
    const startTime = Date.now();

    try {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        logger.warn('Cue sync proxy: missing auth header', { requestId });
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const token = authHeader.slice(7);
      const user = await validateSession(supabase, token);
      if (!user) {
        logger.warn('Cue sync proxy: invalid session', { requestId, userId: user?.id });
        return res.status(401).json({ error: 'Invalid session' });
      }

      logger.info('Cue sync proxy: forwarding push', { requestId, userId: user.id });

      const response = await fetch(`${BACKSTAGE_URL}/v1/push`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${BACKSTAGE_TOKEN}`,
        },
        body: JSON.stringify(req.body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error('Cue sync proxy: Backstage error', {
          requestId,
          status: response.status,
          error: errorText,
        });
        return res.status(502).json({ error: 'Backstage unavailable' });
      }

      const data = await response.json();
      logger.info('Cue sync proxy: success', { requestId, duration: Date.now() - startTime });
      res.json(data);
    } catch (err) {
      logger.error('Cue sync proxy: error', { requestId, error: err.message });
      res.status(500).json({ error: 'Proxy error' });
    }
  });

  app.get('/v1/cue/pull', async (req, res) => {
    const requestId = crypto.randomUUID();

    try {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const token = authHeader.slice(7);
      const user = await validateSession(supabase, token);
      if (!user) return res.status(401).json({ error: 'Invalid session' });

      const since = req.query.since || '0';
      const response = await fetch(`${BACKSTAGE_URL}/v1/pull?since=${since}`, {
        headers: { Authorization: `Bearer ${BACKSTAGE_TOKEN}` },
      });

      if (!response.ok) {
        return res.status(502).json({ error: 'Backstage unavailable' });
      }

      const data = await response.json();
      res.json(data);
    } catch (err) {
      logger.error('Cue pull proxy error', { requestId, error: err.message });
      res.status(500).json({ error: 'Proxy error' });
    }
  });
}

module.exports = { setupCueSyncProxy };