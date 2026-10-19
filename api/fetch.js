import { handleFetch, sendJson } from '../server.mjs';

export default function handler(req, res) {
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
  return handleFetch(req, res, new URLSearchParams((req.url || '').split('?')[1] || ''));
}
