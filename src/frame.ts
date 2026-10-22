// Reports contain JavaScript. Isolate them from Cognito credentials and the app DOM.
// Deliberately pair this CSP with a sandbox that omits allow-same-origin.
export function isolatedReport(html: string, channel: string): string {
  if (!/<head\b[^>]*>/i.test(html)) throw new Error('Expected a complete MetaHopper HTML report.');
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">`;
  const safeChannel = JSON.stringify(channel).replace(/</g, '\\u003c');
  const bridge = `<script>
  (() => {
    const channel = ${safeChannel};
    addEventListener('message', event => {
      if (event.source === parent && event.data?.channel === channel && event.data.type === 'resize') {
        dispatchEvent(new Event('resize'));
        if (typeof window.__draw === 'function') window.__draw();
      }
    });
    addEventListener('DOMContentLoaded', () => {
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
