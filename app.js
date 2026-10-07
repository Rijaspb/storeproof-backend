import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import healthRoutes from './routes/healthRoutes.js';
import incidentRoutes from './routes/incidentRoutes.js';
import storeRoutes from './routes/storeRoutes.js';
import contactRoutes from './routes/contactRoutes.js';
import footageRoutes from './routes/footageRoutes.js';
import notFound from './middleware/notFound.js';
import errorHandler from './middleware/errorHandler.js';
import { globalLimiter } from './middleware/rateLimit.js';

if (!process.env.FRONTEND_URL) throw new Error('FRONTEND_URL is not set');

const app = express();

app.disable('x-powered-by');


if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY));
app.use(morgan('combined', { skip: (req) => req.originalUrl.startsWith('/health') }));
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL }));
app.use(globalLimiter);
app.use(express.json());

app.get('/', (_req, res) => {
  res.json({ message: 'Server is running' });
});

app.use('/health', healthRoutes);
app.use('/incidents/:incidentId/footage', footageRoutes);
app.use('/incidents', incidentRoutes);
app.use('/store', storeRoutes);
app.use('/contact', contactRoutes);

app.use(notFound);
app.use(errorHandler);

export default app;
