import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import authRoutes from './routes/auth.js';
import conversationRoutes from './routes/conversations.js';
import chatRoutes from './routes/chat.js';
import trainRoutes from './routes/train.js';
import v1Routes from './routes/v1.js';
import analyticsRoutes from './routes/analytics.js';
import sdkRoutes from './routes/sdk.js';
import { engineInfo } from './engine/index.js';
import { load as loadModel, save as saveModel, isTrained } from './ml/trainer.js';
import {
  assertSecrets,
  securityHeaders,
  requestId,
  apiLimiter,
  authLimiter,
  chatLimiter,
  trainLimiter,
  publicApiLimiter,
} from './lib/security.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Fail fast on weak secrets in production.
assertSecrets();

app.set('trust proxy', 1);
app.disable('x-powered-by');

// Security headers (Helmet + CSP), request ids.
app.use(securityHeaders());
app.use(requestId);

// Body parsing with strict limits.
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());

// CORS: same-origin by default; lock down via CLIENT_ORIGIN in production.
const corsOrigin = process.env.CLIENT_ORIGIN
  ? process.env.CLIENT_ORIGIN.split(',').map((s) => s.trim())
  : process.env.NODE_ENV === 'production'
    ? false // same-origin only (app is served by this server)
    : true;
app.use(cors({ origin: corsOrigin, credentials: true }));

// Reject oversized/garbled JSON cleanly.
app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Payload too large.' });
  if (err instanceof SyntaxError && 'body' in err) return res.status(400).json({ error: 'Invalid JSON.' });
  next(err);
});

// Per-route rate limiting.
app.use('/api', apiLimiter);
app.use('/api/auth', authLimiter);
app.use('/api/chat', chatLimiter);
app.use('/api/train', trainLimiter);
app.use('/api/v1', publicApiLimiter);

// Health + engine info
app.get('/api/health', (req, res) => res.json({ ok: true, service: 'xenara', engine: engineInfo() }));

app.use('/api/auth', authRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/train', trainRoutes);
app.use('/api/v1', v1Routes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/sdk', sdkRoutes);

// Load a previously trained neural model from disk if present.
if (loadModel()) {
  console.log('  Loaded trained Xenara neural model from disk.');
}

// Serve the built React client in production.
const clientDist = path.join(__dirname, '../../client/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
    res.sendFile(path.join(clientDist, 'index.html'));
  });
} else {
  app.get('/', (req, res) =>
    res.send('<h1>Xenara API</h1><p>Client not built yet. Run the build step.</p>')
  );
}

// Global error handler — never leak stack traces to clients.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', req.id, err?.message);
  if (res.headersSent) return;
  res.status(err.status || 500).json({ error: 'Internal server error', requestId: req.id });
});

const server = app.listen(PORT, () => {
  console.log(`\n  Xenara server running on port ${PORT}`);
  console.log(`  Engine mode: ${engineInfo().mode} (${engineInfo().model})\n`);
});

// Flush any pending learned weights to disk on shutdown so continual learning
// is never lost.
function shutdown(signal) {
  try {
    if (isTrained()) saveModel();
  } catch {
    /* ignore */
  }
  server.close(() => process.exit(0));
  // Force-exit if close hangs.
  setTimeout(() => process.exit(0), 2000).unref();
  void signal;
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
