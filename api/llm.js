import { handleLlm, sendJson } from '../server.mjs';

export default function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
  return handleLlm(req, res, process.env);
}
