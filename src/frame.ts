// Reports contain JavaScript. Isolate them from Cognito credentials and the app DOM.
// Deliberately pair this CSP with a sandbox that omits allow-same-origin.
export function isolatedReport(html: string, channel: string): string {
  if (!/<head\b[^>]*>/i.test(html)) throw new Error('Expected a complete MetaHopper HTML report.');
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">`;
  const safeChannel = JSON.stringify(channel).replace(/</g, '\\u003c');
  const bridge = `<script>
  (() => {
    const channel = ${safeChannel};
    const pending = new Map(); let serial = 0;
    window.metahopperLoadAsset = path => new Promise((resolve, reject) => {
      const id = 'asset-' + (++serial);
      const timer = setTimeout(() => { pending.delete(id); reject(Error('Sample asset request timed out')); }, 180000);
      pending.set(id, {resolve, reject, timer});
      parent.postMessage({channel, type:'asset-request', id, path}, '*');
    });
    addEventListener('message', event => {
      if (event.source === parent && event.data?.channel === channel && event.data.type === 'asset-response') {
        const request = pending.get(event.data.id); if (!request) return;
        pending.delete(event.data.id); clearTimeout(request.timer);
        if (event.data.error) request.reject(Error(event.data.error));
        else if (event.data.buffer instanceof ArrayBuffer) request.resolve(event.data.buffer);
        else request.reject(Error('Invalid sample asset response'));
      }
      if (event.source === parent && event.data?.channel === channel && event.data.type === 'resize') {
        dispatchEvent(new Event('resize'));
        if (typeof window.__draw === 'function') window.__draw();
      }
    });
    addEventListener('DOMContentLoaded', () => {
      document.addEventListener('click', async event => {
        const anchor = event.target?.closest?.('a[data-sample-asset], a[download]');
        if (!anchor) return;
        const path = anchor.getAttribute('data-sample-asset') || anchor.getAttribute('href');
        const manifest = document.getElementById('metahopper-assets');
        if (!path || !manifest) return;
        let files; try { files = JSON.parse(manifest.textContent).files; } catch { return; }
        if (!files?.[path]) return;
        event.preventDefault();
        try {
          const buffer = await window.metahopperLoadAsset(path);
          const url = URL.createObjectURL(new Blob([buffer]));
          const download = document.createElement('a'); download.href=url; download.download=path.split('/').pop();
          document.body.appendChild(download); download.click(); download.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch(error) { alert('Sample file unavailable: ' + error.message); }
      });
      // This MetaHopper version enables #exp when manual sub-bin assignments exist.
      const button = document.getElementById('exp');
      if (button) {
        const update = () => parent.postMessage({channel, type:'edited', value: !button.disabled}, '*');
        new MutationObserver(update).observe(button, {attributes:true, attributeFilter:['disabled']});
        update();
      }
    });
  })();
  </script>`;
  return html.replace(/<head\b[^>]*>/i, (head) => head + csp + bridge);
}

