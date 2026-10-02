import express from 'express';
import cors from 'cors';
import healthRoutes from './routes/healthRoutes.js';
import authRoutes from './routes/authRoutes.js';
import incidentRoutes from './routes/incidentRoutes.js';
import storeRoutes from './routes/storeRoutes.js';
import notFound from './middleware/notFound.js';
import errorHandler from './middleware/errorHandler.js';

const app = express();

app.disable('x-powered-by');
app.use(cors({ origin: process.env.FRONTEND_URL }));
app.use(express.json());

app.get('/', (_req, res) => {
  res.json({ message: 'Server is running' });
});

app.use('/health', healthRoutes);
app.use('/auth', authRoutes);
app.use('/incidents', incidentRoutes);
app.use('/store', storeRoutes);

app.use(notFound);
app.use(errorHandler);

export default app;
