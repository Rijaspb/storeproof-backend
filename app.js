import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import healthRoutes from './routes/healthRoutes.js';
import authRoutes from './routes/authRoutes.js';
import incidentRoutes from './routes/incidentRoutes.js';
import storeRoutes from './routes/storeRoutes.js';
import contactRoutes from './routes/contactRoutes.js';
import footageRoutes from './routes/footageRoutes.js';
import notFound from './middleware/notFound.js';
import errorHandler from './middleware/errorHandler.js';
import { globalLimiter } from './middleware/rateLimit.js';

const app = express();

app.disable('x-powered-by');

// Behind a reverse proxy (Render, Railway, Fly...) set TRUST_PROXY=1 so req.ip is the
// real client IP, which the rate limiters rely on
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY));
app.use(helmet());
app.use(globalLimiter);
app.use(cors({ origin: process.env.FRONTEND_URL }));
app.use(express.json());

app.get('/', (_req, res) => {
  res.json({ message: 'Server is running' });
});

app.use('/health', healthRoutes);
app.use('/auth', authRoutes);
app.use('/incidents', incidentRoutes);
app.use('/store', storeRoutes);
app.use('/contact', contactRoutes);
app.use('/incidents/:incidentId/footage', footageRoutes);

app.use(notFound);
app.use(errorHandler);

export default app;
