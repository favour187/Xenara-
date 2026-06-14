import { useEffect, useState } from 'react';
import { api, streamPost } from '../api.js';

function LossChart({ history }) {
  if (!history.length) return null;
  const W = 320;
  const H = 90;
  const losses = history.map((h) => h.loss);
  const max = Math.max(...losses);
  const min = Math.min(...losses, 0);
  const pts = history.map((h, i) => {
    const x = history.length === 1 ? 0 : (i / (history.length - 1)) * W;
    const y = H - ((h.loss - min) / (max - min || 1)) * H;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg className="loss-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <polyline
        points={pts.join(' ')}
        fill="none"
        stroke="#7c5cff"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export default function TrainPanel({ onClose, onTrained }) {
  const [status, setStatus] = useState(null);
  const [epochs, setEpochs] = useState(30);
  const [arch, setArch] = useState('mlp');
  const [training, setTraining] = useState(false);
  const [progress, setProgress] = useState(null);
  const [history, setHistory] = useState([]);
  const [sample, setSample] = useState('');
  const [corpus, setCorpus] = useState(null);
  const [extraCorpus, setExtraCorpus] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/api/train/status').then((s) => {
      setStatus(s);
      if (s.history?.length) setHistory(s.history);
    }).catch(() => {});
    api.get('/api/train/corpus').then(setCorpus).catch(() => {});
  }, []);

  async function startTraining() {
    setError('');
    setTraining(true);
    setHistory([]);
    setSample('');
    setProgress({ epoch: 0, epochs, step: 0, steps: 1, loss: 0 });

    await streamPost(
      '/api/train/start',
      { epochs: Number(epochs), extraCorpus },
      {
        progress: (p) => {
          setProgress(p);
          if (p.epochDone) setHistory((h) => [...h, { epoch: p.epoch, loss: p.loss }]);
        },
        done: (d) => {
          setSample(d.sample || '');
          setStatus({ status: 'trained', meta: d.meta, isReady: true });
          setTraining(false);
          onTrained?.();
        },
        error: (e) => {
          setError(e.message);
          setTraining(false);
        },
      }
    );
  }

  const pct = progress && progress.steps
    ? Math.min(100, Math.round(((progress.epoch - 1 + progress.step / progress.steps) / epochs) * 100))
    : 0;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal train-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>🧠 Train Xenara's Neural Model</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <p className="muted small">
          This trains a real neural network <b>from scratch</b> (embeddings → hidden layer →
          softmax) using backpropagation and gradient descent — entirely on this server, no
          external API. It's small, so it learns Xenara's style rather than world knowledge.
        </p>

        {status?.meta && !training && (
          <div className="train-stat-grid">
            <div><span className="muted small">Status</span><b>{status.isReady ? 'Trained ✓' : status.status}</b></div>
            <div><span className="muted small">Parameters</span><b>{status.meta.params?.toLocaleString()}</b></div>
            <div><span className="muted small">Vocab</span><b>{status.meta.vocabSize}</b></div>
            <div><span className="muted small">Final loss</span><b>{status.meta.finalLoss?.toFixed(3)}</b></div>
          </div>
        )}

        {corpus && (
          <div className="muted small corpus-info">
            Corpus: {corpus.chars.toLocaleString()} characters, {corpus.lines} lines.
          </div>
        )}

        <label className="train-label">
          Add your own training text (optional)
          <textarea
            value={extraCorpus}
            onChange={(e) => setExtraCorpus(e.target.value)}
            placeholder="Paste extra text for Xenara to learn from…"
            rows={3}
            disabled={training}
          />
        </label>

        <div className="train-controls">
          <label>
            Epochs: <b>{epochs}</b>
            <input
              type="range" min="5" max="60" value={epochs}
              onChange={(e) => setEpochs(Number(e.target.value))}
              disabled={training}
            />
          </label>
          <button className="primary" onClick={startTraining} disabled={training}>
            {training ? 'Training…' : status?.isReady ? 'Re-train' : 'Start training'}
          </button>
        </div>

        {(training || progress) && (
          <div className="train-progress">
            <div className="progress-bar"><div className="progress-fill" style={{ width: `${pct}%` }} /></div>
            <div className="progress-meta muted small">
              {progress ? `Epoch ${progress.epoch}/${progress.epochs} · loss ${progress.loss?.toFixed(4)}` : ''}
              {' '}({pct}%)
            </div>
          </div>
        )}

        {history.length > 0 && (
          <div className="chart-wrap">
            <div className="muted small">Training loss ↓</div>
            <LossChart history={history} />
          </div>
        )}

        {sample && (
          <div className="sample-out">
            <div className="muted small">Sample from the trained model:</div>
            <pre>{sample}</pre>
          </div>
        )}

        {error && <div className="error">{error}</div>}
      </div>
    </div>
  );
}
