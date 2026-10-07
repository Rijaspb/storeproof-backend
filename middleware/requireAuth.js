import { verifyToken } from '../auth/index.js';

// jose error codes caused by the token itself (not ERR_JWKS_TIMEOUT / generic fetch failures)
const TOKEN_ERROR = /^ERR_(JWT_|JWS_|JOSE_ALG_NOT_ALLOWED|JWKS_NO_MATCHING_KEY|JWKS_MULTIPLE_MATCHING_KEYS)/;

// Sets req.userId from a valid Supabase access token, otherwise responds 401
export default async function requireAuth(req, res, next) {
  const [scheme, token] = (req.headers.authorization ?? '').split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    req.userId = (await verifyToken(token)).sub;
  } catch (err) {
    // Only real token problems are 401; JWKS fetch/timeout failures are server errors
    if (TOKEN_ERROR.test(err?.code)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return next(err);
  }

  if (!req.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}
