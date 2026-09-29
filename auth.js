import { SignJWT, jwtVerify } from 'jose';

if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET is not set');
}

const secret = new TextEncoder().encode(process.env.JWT_SECRET);

export const signToken = (payload) =>
  new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('2h')
    .sign(secret);

// Throws if the token is invalid or expired
export const verifyToken = async (token) =>
  (await jwtVerify(token, secret, { algorithms: ['HS256'] })).payload;
