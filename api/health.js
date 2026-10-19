// Vercel entry points reuse the local server's handlers, with the project's environment variables.
import { health, sendJson } from '../server.mjs';

export default function handler(req, res) {
  sendJson(res, 200, health(process.env));
}
