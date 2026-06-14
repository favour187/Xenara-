// Serve downloadable SDK client files for using your Xenara API in your work.

import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SDK_DIR = path.join(__dirname, '../../sdk');

const router = express.Router();

const FILES = {
  python: { file: 'xenara.py', type: 'text/x-python', name: 'xenara.py' },
  node: { file: 'xenara.js', type: 'text/javascript', name: 'xenara.js' },
};

router.get('/:lang', (req, res) => {
  const spec = FILES[req.params.lang];
  if (!spec) return res.status(404).json({ error: 'Unknown SDK. Use python or node.' });
  const filePath = path.join(SDK_DIR, spec.file);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'SDK file not found' });
  res.setHeader('Content-Type', spec.type);
  res.setHeader('Content-Disposition', `attachment; filename="${spec.name}"`);
  fs.createReadStream(filePath).pipe(res);
});

export default router;
