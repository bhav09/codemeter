type PairingInfo = { port: number; nonce: string; createdAt: number };

chrome.runtime.onMessage.addListener((msg: any, _sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void) => {
  if (msg?.type === 'codemeter_pairing_info') {
    const info: PairingInfo = msg.info;
    chrome.storage.session.set({ codemeterPairingInfo: info }).then(() => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg?.type === 'codemeter_pair_now') {
    void pairNow().then(
      (r) => sendResponse({ ok: true, ...r }),
      (e) => sendResponse({ ok: false, error: String(e?.message || e) })
    );
    return true;
  }
});

async function pairNow(): Promise<{ status: string }> {
  const { codemeterPairingInfo } = await chrome.storage.session.get('codemeterPairingInfo');
  if (!codemeterPairingInfo) throw new Error('Open the CodeMeter pairing page in your browser first.');

  const info = codemeterPairingInfo as PairingInfo;

  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const url = tab?.url || '';
  if (!url.startsWith('https://cursor.com/')) {
    throw new Error('Open a logged-in cursor.com tab, then try again.');
  }

  const cookie = await chrome.cookies.get({ url: 'https://cursor.com', name: 'WorkosCursorSessionToken' });
  const token = cookie?.value;
  if (!token) throw new Error('Could not read WorkosCursorSessionToken. Are you logged in to cursor.com?');

  const res = await fetch(`http://127.0.0.1:${info.port}/pair/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce: info.nonce, sessionToken: token })
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.ok !== true) {
    throw new Error(json?.error || `Pairing failed (${res.status})`);
  }

  return { status: 'paired' };
}


