import { verifyToken } from '../auth/index.js';

// Sets req.userId from a valid Supabase access token, otherwise responds 401
export default async function requireAuth(req, res, next) {
  const [scheme, token] = (req.headers.authorization ?? '').split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    req.userId = (await verifyToken(token)).sub;
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
}
