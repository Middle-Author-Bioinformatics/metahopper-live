// Reports contain JavaScript. Isolate them from Cognito credentials and the app DOM.
// Deliberately pair this CSP with a sandbox that omits allow-same-origin.
import { reportTheme } from './report-theme.ts';
import type { Theme } from './theme';
import { assemblyContext, assemblyNote } from './assembly-context.ts';

export function isolatedReport(html: string, channel: string, theme: Theme = 'light'): string {
  if (!/<head\b[^>]*>/i.test(html)) throw new Error('Expected a complete MetaHopper HTML report.');
  const assembly = assemblyContext(html);
  html = assemblyNote(html, assembly);
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">`;
  // Compact the viewer presentation, including reports already uploaded to S3.
  // Preserve report content and standalone source HTML.
  const presentation = `<style data-metahopper-viewer>
${reportTheme}
body > .wrap{padding-top:12px}
body > .wrap > header > h1{font-size:1.3rem;line-height:1.25}
body > .wrap > header > h1 + p.sub{display:none!important}
#tabs.tabs{margin:10px 0;gap:5px}
#tabs > .tab{padding:6px 11px;font-size:.84rem;line-height:1.35}
#pane-bins > .card:first-of-type{padding:12px 14px}
#pane-bins > .card:first-of-type > .row:first-child{margin-bottom:8px!important}
#pane-bins > .card:first-of-type > p.note{margin:6px 0}
#bin-table tr.mh-search-target td{background:var(--selection);box-shadow:inset 0 2px var(--acc),inset 0 -2px var(--acc)}
.assembly-scope-note{margin:0 0 10px;color:var(--mut);font-size:.8rem;line-height:1.45}.assembly-scope-note strong{color:var(--ink)}
body.mh-shared-rank #bin-rank-control,body.mh-shared-rank [data-shared-rank-control],body.mh-shared-rank .bin-figure-controls{display:none!important}
#bin-search-help,#annotation-browser>.annotation-help:not([role="status"]),#pathway-browser>p.note:not([id]),#pathway-hits-card>p.note:not([id]){display:none!important}
</style>`;
  const safeChannel = JSON.stringify(channel).replace(/</g, '\\u003c');
  const bridge = `<script>
  (() => {
    const channel = ${safeChannel};
    const pending = new Map(); let serial = 0;
    let lastFocus = '';
    const assemblyLabel = ${JSON.stringify(assembly?.label ?? null)};
    function labelAssemblyPlots() {
      if (!assemblyLabel) return;
      const total = document.getElementById('bin-partition-total');
      if (total?.textContent && !total.textContent.startsWith(assemblyLabel + ' · ')) total.textContent = assemblyLabel + ' · ' + total.textContent;
      const svg = document.getElementById('bin-partition-figure')?.querySelector?.('svg');
      if (!svg) return;
      const name = svg.getAttribute('aria-label');
      if (name?.startsWith('Full assembly')) svg.setAttribute('aria-label', name.replace(/^Full assembly/, assemblyLabel));
      svg.querySelectorAll(':scope > title, :scope > text').forEach(node => {
        if (node.textContent) node.textContent = node.textContent.replace(/^Full assembly(?= to |$)/, assemblyLabel);
      });
    }
    function setTheme(value) {
      if (value !== 'light' && value !== 'dark') return;
      const root = document.documentElement;
      if (!root) return;
      root.dataset.theme = value;
      root.setAttribute('data-theme-manual', 'true');
      if (typeof window.__draw === 'function') window.__draw();
    }
    if (typeof document !== 'undefined' && document.documentElement) setTheme(${JSON.stringify(theme === 'dark' ? 'dark' : 'light')});
    function setReportRank(value) {
      if (!['phylum','class','order','family','genus','species'].includes(value)) return;
      const select = document.getElementById('rank-filter');
      if (!select) return;
      // A missing rank must display an empty selection, never another rank's bins.
      if (![...select.options].some(option => option.value === value)) {
        const option = document.createElement('option'); option.value = value;
        option.textContent = value[0].toUpperCase() + value.slice(1) + ' (not produced)';
        select.appendChild(option);
      }
      select.value = value; select.dispatchEvent(new Event('change'));
      select.parentElement?.setAttribute('data-shared-rank-control', '');
      document.body.classList.add('mh-shared-rank');
    }
    function focusBin(data) {
      if (typeof data.bin !== 'string' || data.bin.length > 1000 || !['phylum','class','order','family','genus','species'].includes(data.rank)) return;
      const key = JSON.stringify([data.rank, data.bin, data.request]);
      if (key === lastFocus) return;
      const search = document.getElementById('bin-search'), rank = document.getElementById('rank-filter');
      if (!search || !rank) return;
      const target = [...document.querySelectorAll('#bin-table tbody tr')].find(row => row.dataset.rank === data.rank && row.dataset.binName === data.bin);
      if (!target) return;
      lastFocus = key;
      document.querySelector('.tab[data-id="bins"]')?.click();
      rank.value = data.rank; search.value = data.bin; search.dispatchEvent(new Event('input'));
      document.querySelectorAll('.mh-search-target').forEach(row => row.classList.remove('mh-search-target'));
      target.classList.add('mh-search-target');
      target.scrollIntoView({block:'center', behavior:'smooth'});
    }
    function showAllPathwayBins() {
      // Older published reports re-enable this filter when Reset is clicked.
      // Run after their target handler so those reports work without re-upload.
      const hide = document.getElementById('pathway-hide-zero');
      if (hide?.checked === true) {
        hide.checked = false;
        hide.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    const requestAsset = (path, download) => new Promise((resolve, reject) => {
      const id = 'asset-' + (++serial);
      const timer = setTimeout(() => { pending.delete(id); reject(Error('Sample asset request timed out')); }, 180000);
      pending.set(id, {resolve, reject, timer, download});
      parent.postMessage({channel, type:download ? 'asset-download' : 'asset-request', id, path}, '*');
    });
    window.metahopperLoadAsset = path => requestAsset(path, false);
    window.metahopperDownloadAsset = path => requestAsset(path, true);
    addEventListener('message', event => {
      if (event.source === parent && event.data?.channel === channel && event.data.type === 'asset-response') {
        const request = pending.get(event.data.id); if (!request) return;
        pending.delete(event.data.id); clearTimeout(request.timer);
        if (event.data.error) request.reject(Error(event.data.error));
        else if (request.download && event.data.downloadStarted === true) request.resolve();
        else if (!request.download && event.data.buffer instanceof ArrayBuffer) request.resolve(event.data.buffer);
        else request.reject(Error('Invalid sample asset response'));
      }
      if (event.source === parent && event.data?.channel === channel && event.data.type === 'resize') {
        dispatchEvent(new Event('resize'));
        if (typeof window.__draw === 'function') window.__draw();
      }
      if (event.source === parent && event.data?.channel === channel && event.data.type === 'focus-bin') focusBin(event.data);
      if (event.source === parent && event.data?.channel === channel && event.data.type === 'set-report-rank') setReportRank(event.data.rank);
      if (event.source === parent && event.data?.channel === channel && event.data.type === 'set-theme') setTheme(event.data.theme);
    });
    addEventListener('DOMContentLoaded', () => {
      labelAssemblyPlots();
      if (assemblyLabel) {
        document.addEventListener('metahopper:bins-filter', labelAssemblyPlots);
        document.getElementById('rank-filter')?.addEventListener('change', labelAssemblyPlots);
        document.getElementById('bin-search')?.addEventListener('input', labelAssemblyPlots);
      }
      showAllPathwayBins();
      document.addEventListener('click', async event => {
        if (event.target?.closest?.('#pathway-reset')?.id === 'pathway-reset') {
          showAllPathwayBins();
          return;
        }
        const anchor = event.target?.closest?.('a[data-sample-asset], a[download]');
        if (!anchor) return;
        const path = anchor.getAttribute('data-sample-asset') || anchor.getAttribute('href');
        const manifest = document.getElementById('metahopper-assets');
        if (!path || !manifest) return;
        let files; try { files = JSON.parse(manifest.textContent).files; } catch { return; }
        if (!files?.[path]) return;
        event.preventDefault();
        try {
          if (files[path].downloadOnly || files[path].size > 512 * 1024 * 1024) {
            await window.metahopperDownloadAsset(path);
            return;
          }
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
  return html.replace(/<head\b[^>]*>/i, (head) => head + csp + presentation + bridge);
}


