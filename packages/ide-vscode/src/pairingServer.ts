import * as vscode from 'vscode';
import express, { Express } from 'express';
import { AddressInfo } from 'net';
import { randomBytes } from 'crypto';

export interface PairingServerResult {
  port: number;
  nonce: string;
  dispose: () => Promise<void>;
  awaitToken: () => Promise<{ sessionToken: string }>;
}

const NONCE_TTL_MS = 60_000;

export async function startPairingServer(context: vscode.ExtensionContext): Promise<PairingServerResult> {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '8kb' }));

  const nonce = randomBytes(16).toString('hex');
  const createdAt = Date.now();

  let resolveToken: ((v: { sessionToken: string }) => void) | null = null;
  let rejectToken: ((e: Error) => void) | null = null;
  const tokenPromise = new Promise<{ sessionToken: string }>((resolve, reject) => {
    resolveToken = resolve;
    rejectToken = reject;
  });

  app.get('/pair', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`
      <html>
        <body style="font-family: -apple-system, system-ui, sans-serif; max-width: 720px; margin: 40px auto;">
          <h2>CodeMeter pairing</h2>
          <p>Open the Chrome helper extension and click <b>Pair now</b>.</p>
          <p>Keep this page open. Pairing expires in 60 seconds.</p>
          <hr />
          <pre id="info"></pre>
          <script>
            document.getElementById('info').textContent = JSON.stringify({ nonce: "${nonce}", createdAt: ${createdAt} }, null, 2);
          </script>
        </body>
      </html>
    `);
  });

  app.get('/pair/info', (_req, res) => {
    res.json({ nonce, createdAt });
  });

  app.post('/pair/submit', (req, res) => {
    const ip = req.ip || '';
    const isLocal =
      ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (!isLocal) {
      res.status(403).json({ ok: false, error: 'Only loopback connections are allowed' });
      return;
    }

    if (Date.now() - createdAt > NONCE_TTL_MS) {
      res.status(410).json({ ok: false, error: 'Pairing window expired' });
      return;
    }

    const body = req.body || {};
    if (body.nonce !== nonce) {
      res.status(400).json({ ok: false, error: 'Invalid nonce' });
      return;
    }

    const sessionToken = String(body.sessionToken || '');
    if (!sessionToken || sessionToken.length < 10) {
      res.status(400).json({ ok: false, error: 'Invalid session token' });
      return;
    }

    // Store token securely
    void context.secrets.store('cursor.sessionToken', sessionToken);

    res.json({ ok: true });
    resolveToken?.({ sessionToken });
  });

  const server = await new Promise<ReturnType<Express['listen']>>((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });

  const port = (server.address() as AddressInfo).port;

  return {
    port,
    nonce,
    dispose: async () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
    awaitToken: async () => {
      const timeout = setTimeout(() => {
        rejectToken?.(new Error('Pairing timed out'));
      }, NONCE_TTL_MS + 5_000);
      try {
        return await tokenPromise;
      } finally {
        clearTimeout(timeout);
      }
    }
  };
}


