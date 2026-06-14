"""
Xenara Python SDK — call your private Xenara from your own work.

Usage:
    from xenara import Xenara
    client = Xenara(api_key="xen_live_xxx", base_url="https://YOUR-APP.onrender.com")

    # Simple chat
    print(client.chat("Summarize the theory of relativity"))

    # With live web research + history
    reply = client.chat(
        "What's the latest news on AI?",
        web="on",
        history=[{"role": "user", "content": "Hi"}, {"role": "assistant", "content": "Hello!"}],
    )

    # Streaming
    for chunk in client.stream("Write a short poem about the sea"):
        print(chunk, end="", flush=True)

Requires: requests  (pip install requests)
"""

import json
import requests


class Xenara:
    def __init__(self, api_key, base_url="http://localhost:3000", timeout=120):
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def _headers(self):
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    def info(self):
        r = requests.get(f"{self.base_url}/api/v1/info", headers=self._headers(), timeout=self.timeout)
        r.raise_for_status()
        return r.json()

    def chat(self, message, engine="auto", web="auto", history=None):
        """Return the full reply as a string."""
        body = {"message": message, "engine": engine, "web": web, "history": history or []}
        r = requests.post(
            f"{self.base_url}/api/v1/chat",
            headers=self._headers(),
            data=json.dumps(body),
            timeout=self.timeout,
        )
        r.raise_for_status()
        return r.json().get("reply", "")

    def chat_full(self, message, **kwargs):
        """Return the full JSON response (reply, sources, learned, ...)."""
        body = {"message": message, **kwargs}
        r = requests.post(
            f"{self.base_url}/api/v1/chat",
            headers=self._headers(),
            data=json.dumps(body),
            timeout=self.timeout,
        )
        r.raise_for_status()
        return r.json()

    def stream(self, message, engine="auto", web="auto", history=None):
        """Yield reply text chunks as they arrive (SSE)."""
        body = {"message": message, "engine": engine, "web": web, "stream": True, "history": history or []}
        with requests.post(
            f"{self.base_url}/api/v1/chat",
            headers=self._headers(),
            data=json.dumps(body),
            stream=True,
            timeout=self.timeout,
        ) as r:
            r.raise_for_status()
            event = None
            for raw in r.iter_lines(decode_unicode=True):
                if raw is None:
                    continue
                line = raw.strip()
                if line.startswith("event:"):
                    event = line[6:].strip()
                elif line.startswith("data:"):
                    data = line[5:].strip()
                    try:
                        parsed = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    if event == "delta" and parsed.get("text"):
                        yield parsed["text"]
                    elif event == "done":
                        return


if __name__ == "__main__":
    import os

    client = Xenara(
        api_key=os.environ.get("XENARA_API_KEY", "xen_live_xxx"),
        base_url=os.environ.get("XENARA_BASE_URL", "http://localhost:3000"),
    )
    print(client.chat("Hello Xenara, introduce yourself."))
