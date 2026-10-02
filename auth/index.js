import { createRemoteJWKSet, jwtVerify } from 'jose';

if (!process.env.SUPABASE_URL) {
  throw new Error('SUPABASE_URL is not set');
}

const issuer = `${process.env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1`;
const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));

// Throws if the token is invalid, expired, or not issued by this Supabase project
export const verifyToken = async (token) =>
  (await jwtVerify(token, jwks, {
    issuer,
    audience: 'authenticated',
    algorithms: ['ES256'],
  })).payload;
