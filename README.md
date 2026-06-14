# Xenara — Your AI Assistant

A full-stack, Claude-style AI assistant: streaming chat, user accounts, saved
conversation history, and a **pluggable engine** so it works out of the box and
can be upgraded to any real language model.

![brand](https://img.shields.io/badge/Xenara-AI%20Assistant-7c5cff)

## ✨ Features

- 🔒 **Single-owner & private** — the first account becomes the owner and
  registration then **locks**, so the instance is yours alone
- 🔑 **Personal API key** — call Xenara from your own apps via `POST /api/v1/chat`
- 🔁 **Continual learning** — **every question trains the model a little more**
  (real online gradient updates), and the learned text grows Xenara's corpus
- 💬 **Streaming chat UI** (token-by-token) with Markdown, code blocks, and tables
- 🧠 **Train your own neural model from scratch** — a real neural network
  (embeddings → hidden layer → softmax) trained with **backpropagation + gradient
  descent**, in-browser-triggered, running on CPU with **no external API**.
  Watch the loss go down live and chat with your trained model.
- 🔀 **Model selector** — switch between Xenara Core, your trained Neural model,
  and any connected external LLM
- 🌐 **Live web research** — Xenara gathers resources & data from the open web,
  reads pages, and answers with **inline citations + clickable sources**
- 👤 **Accounts** — register / login (JWT + secure cookies, hashed passwords)
- 🗂️ **Conversation history** — saved per user, rename & delete
- 🧠 **Pluggable engine**
  - **Xenara Core** — built-in, runs anywhere with **zero API keys**
  - **Connected mode** — point at any OpenAI-compatible endpoint (OpenAI,
    OpenRouter, Groq, Together, local **Ollama**, LM Studio, vLLM…)
- 📱 Responsive design (mobile sidebar), dark theme
- 🛡️ Rate limiting, input sanitization, SSE streaming
- 🚀 One-click **Render** deploy (`render.yaml` blueprint included)

## 🌐 Web research (gathering world data)

Xenara can pull live information from the internet to answer questions.

- **Keyless by default** — uses Bing/DuckDuckGo HTML search out of the box, so
  it works with no API keys.
- **Auto mode** — Xenara decides when to search (questions about latest/current
  events, prices, news, "who/what/when is…", pasted URLs, recent years, etc.).
- **Manual toggle** — the composer has a **🌐 Web** button: `Auto → On → Off`.
- **Citations** — answers include inline `[1]`, `[2]` markers and a clickable
  **Sources** list. The sources are streamed to the UI live as Xenara reads them.
- **Optional premium providers** — set `TAVILY_API_KEY` or `BRAVE_API_KEY` for
  higher-quality search; Xenara auto-detects and uses them.

Extra API endpoints (authenticated):

| Endpoint | Purpose |
|----------|---------|
| `POST /api/chat/search` `{query, limit}` | Raw web search results |
| `POST /api/chat/fetch`  `{url}`          | Fetch + extract readable page text |
| `POST /api/chat/stream` `{content, web}` | Chat with `web: "auto"\|"on"\|"off"` |

Disable web access entirely with `XENARA_WEB=off`.

## 🏗️ Tech stack

| Layer    | Tech                                            |
|----------|-------------------------------------------------|
| Frontend | React 18 + Vite, `marked` for Markdown          |
| Backend  | Node.js + Express, Server-Sent Events streaming |
| Database | SQLite (`better-sqlite3`)                        |
| Auth     | JWT + bcrypt + httpOnly cookies                 |

## 🚀 Quick start (local)

```bash
cd xenara

# install everything (root + client + server)
npm run install:all

# run client (5173) + server (3000) together
npm run dev
```

Open http://localhost:5173

### Production build & run

```bash
npm run build   # builds client into client/dist, installs server deps
npm start       # serves API + built client on PORT (default 3000)
```

Open http://localhost:3000

## 🔒 Own it: single-owner mode + your personal API key

Xenara is built to be **yours alone**:

1. The **first account** you create becomes the **owner**, and **registration
   closes automatically** — nobody else can sign up.
2. You get a personal API key like `xen_live_…`. Open the **🔑 My API key**
   button in the sidebar to reveal, copy, or rotate it.

### Use Xenara in your own work

```bash
curl -X POST https://YOUR-APP.onrender.com/api/v1/chat \
  -H "Authorization: Bearer xen_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{"message": "Summarize this for me", "web": "auto"}'
```

```js
const res = await fetch("https://YOUR-APP.onrender.com/api/v1/chat", {
  method: "POST",
  headers: { Authorization: "Bearer xen_live_xxx", "Content-Type": "application/json" },
  body: JSON.stringify({ message: "Hello Xenara", web: "auto", stream: false }),
});
const { reply } = await res.json();
```

API surface (auth: `Authorization: Bearer xen_live_...` **or** `x-api-key`):

| Endpoint | Purpose |
|----------|---------|
| `POST /api/v1/chat` | Chat. Body: `{ message, engine?, web?, stream?, history? }`. `stream:true` → SSE |
| `GET  /api/v1/info` | Engine + continual-learning status |
| `GET  /api/auth/api-key` | View your key (session only) |
| `POST /api/auth/api-key/rotate` | Rotate your key |

## 🔁 Continual learning — every question trains Xenara

When the neural model is trained, **each question runs real gradient-descent
updates** on the model (online learning), and the text is appended to a
persistent `learned.txt` that's folded into future full retrains. Over time
Xenara adapts to your style and vocabulary.

- Works for both the chat UI and the `/api/v1/chat` API.
- Stats (interactions, characters learned, last loss) show in the **🔑 My API
  key** panel, and a *"🧠 Learned from this exchange"* chip appears under
  replies.
- Weights are saved (debounced) and **flushed on shutdown** so nothing is lost.
- Disable with `XENARA_LEARN=off`.

> Honest note: this is genuine online training of a small CPU model, so it
> adapts *style*, not world knowledge. Connect an external model for frontier
> reasoning while still keeping your private, ever-learning Xenara model.

## 🧠 Training Xenara's own neural model (real, from scratch)

Click the **🧠 Train** button in the app to open the training panel. There you can:

- Set the number of **epochs** and optionally **paste your own training text**.
- Press **Start training** and watch the **loss curve drop live** as Xenara
  learns, then see a **sample** of generated text.
- Switch the model selector to **"Xenara Neural (trained)"** to chat with it.

**What it actually is:** a genuine character-level neural language model — the
classic Bengio-style neural LM that GPT/Claude architectures descend from:

```
prev chars → embedding lookup → concat → hidden (tanh) → softmax over vocab
```

It's trained with hand-written **forward + backward passes** (real
backpropagation), cross-entropy loss, SGD with learning-rate decay, and shuffled
mini-epochs — all in pure JavaScript (`server/src/ml/`), no ML libraries, no GPU,
no external API. Because a CPU-trainable model is tiny (tens of thousands of
parameters), it learns Xenara's **writing style**, not world knowledge — so for
real intelligence, also connect an external model (below). Honest by design.

Add your own corpus files: drop `.txt` files into `server/data/corpus/` (or the
persistent disk's `corpus/` folder) and they're included in training.

Training API (authenticated):

| Endpoint | Purpose |
|----------|---------|
| `GET  /api/train/status`   | Model + training status, loss history |
| `GET  /api/train/corpus`   | Info about the training corpus |
| `POST /api/train/start`    | Train (SSE live progress) `{epochs, extraCorpus}` |
| `POST /api/train/generate` | Generate text `{prompt, maxTokens, temperature}` |

> The trained model is saved to `xenara-model.json` on the data dir and
> auto-loaded on startup. On Render, the persistent disk keeps it across deploys.

## 🧠 Connecting a real language model (optional)

By default Xenara uses its built-in **Xenara Core** engine. To upgrade it to a
frontier model, set these environment variables (see `server/.env.example`):

```bash
XENARA_MODEL_URL=https://api.openai.com/v1   # any OpenAI-compatible base URL
XENARA_MODEL_KEY=sk-...                       # API key (omit for local servers)
XENARA_MODEL_NAME=gpt-4o-mini                 # model id
```

Examples:
- **OpenAI:** `https://api.openai.com/v1`
- **OpenRouter:** `https://openrouter.ai/api/v1`
- **Local Ollama:** `http://localhost:11434/v1` (no key, e.g. `XENARA_MODEL_NAME=llama3.1`)

Xenara automatically detects the config and streams from the model; if the model
call fails it gracefully falls back to Xenara Core.

## ☁️ Deploy on Render

This repo includes a `render.yaml` blueprint.

1. Push this `xenara/` folder to a GitHub repository.
2. In [Render](https://render.com): **New + → Blueprint**, select your repo.
3. Render reads `render.yaml`, provisions a web service + 1GB persistent disk,
   and generates a secure `JWT_SECRET`.
4. (Optional) In the service **Environment** tab, add `XENARA_MODEL_URL`,
   `XENARA_MODEL_KEY`, `XENARA_MODEL_NAME` to connect a real model.
5. Deploy. Your app is live at `https://<your-service>.onrender.com`.

> The SQLite database is stored on the persistent disk at `/var/data`, so user
> accounts and chat history survive redeploys.

### Manual Render setup (without blueprint)
- **Build command:** `npm install && npm run build`
- **Start command:** `npm start`
- **Health check path:** `/api/health`
- Add a persistent disk mounted at `/var/data` and set `DATA_DIR=/var/data`.

## 📁 Project structure

```
xenara/
├── render.yaml            # Render blueprint
├── package.json           # root scripts (build/start/dev)
├── client/                # React + Vite frontend
│   └── src/
│       ├── components/     # Auth, Sidebar, Chat, Markdown
│       ├── App.jsx
│       └── api.js          # API + SSE streaming client
└── server/                # Express backend
    └── src/
        ├── index.js        # app entry, serves API + client build
        ├── routes/         # auth, conversations, chat (SSE)
        ├── engine/         # Xenara Core + OpenAI-compatible adapter
        └── lib/            # db (SQLite), auth (JWT)
```

## ⚠️ Note on "building an AI"

Training a frontier model from scratch (like Anthropic's Claude) requires
enormous compute, data, and funding. Xenara instead gives you a complete,
production-ready **AI product**: your own brand, UI, accounts, and history, with
a clean adapter to plug in whatever model brain you choose — from the free
built-in engine to a self-hosted open-source model or a hosted API.

## 📄 License

MIT — build on it freely.
