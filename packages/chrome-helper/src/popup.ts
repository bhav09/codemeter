const statusEl = document.getElementById('status') as HTMLDivElement;
const btn = document.getElementById('pair') as HTMLButtonElement;

btn.addEventListener('click', async () => {
  setStatus('Pairing…');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'codemeter_pair_now' });
    if (!res?.ok) throw new Error(res?.error || 'Unknown error');
    setStatus('Paired successfully. You can return to the IDE.');
  } catch (e: any) {
    setStatus(`Pairing failed: ${String(e?.message || e)}`);
  }
});

function setStatus(s: string) {
  statusEl.textContent = s;
}


