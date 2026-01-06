async function main() {
  try {
    const u = new URL(window.location.href);
    const port = Number(u.port);
    if (!port) return;

    const res = await fetch(`http://127.0.0.1:${port}/pair/info`);
    const info = await res.json();
    if (!info?.nonce) return;

    chrome.runtime.sendMessage({ type: 'codemeter_pairing_info', info: { port, nonce: info.nonce, createdAt: info.createdAt } });
  } catch {
    // ignore
  }
}

void main();


