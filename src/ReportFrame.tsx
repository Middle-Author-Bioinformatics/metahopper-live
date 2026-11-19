import { useEffect, useRef, useState } from 'react';
import type { Report } from './catalog';
import { isolatedReport } from './frame';
import { downloadReportAsset, readReport, readReportAsset } from './storage';
import { assetManifest, type AssetManifest } from './assets';
import type { BinFocus, Rank } from './taxonomy';
import type { Theme } from './theme';

interface Props {
  report: Report; active: boolean; removed: boolean;
  onEdited: (path: string, edited: boolean) => void;
  binFocus?: BinFocus;
  rank: Rank;
  theme: Theme;
}
export default function ReportFrame({ report, active, removed, onEdited, binFocus, rank, theme }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const channel = useRef(crypto.randomUUID());
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const [loaded, setLoaded] = useState<{ version: string; html: string; manifest: AssetManifest | null }>();
  const [edited, setEdited] = useState(false);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const stale = loaded && loaded.version !== report.version;

  useEffect(() => {
    const requests = new Map<string, AbortController>();
    const handler = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.data?.channel !== channel.current) return;
      if (event.data.type === 'edited' && typeof event.data.value === 'boolean') {
        setEdited(event.data.value);
        onEdited(report.path, event.data.value);
      }
      if ((event.data.type === 'asset-request' || event.data.type === 'asset-download') && typeof event.data.id === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(event.data.id)
          && typeof event.data.path === 'string' && requests.size < 4 && !requests.has(event.data.id)) {
        const id = event.data.id, target = frame.current?.contentWindow;
        if (!target) return;
        const controller = new AbortController(); requests.set(id, controller);
        const download = event.data.type === 'asset-download';
        const task = download
          ? downloadReportAsset(report.path, loaded?.manifest ?? null, event.data.path, controller.signal)
          : readReportAsset(report.path, loaded?.manifest ?? null, event.data.path, controller.signal);
        void task.then((buffer) => {
          if (!controller.signal.aborted && target === frame.current?.contentWindow) {
            if (download) target.postMessage({ channel: channel.current, type: 'asset-response', id, downloadStarted: true }, '*');
            else if (buffer instanceof ArrayBuffer) target.postMessage({ channel: channel.current, type: 'asset-response', id, buffer }, '*', [buffer]);
          }
        }).catch((error: unknown) => {
          if (!controller.signal.aborted && target === frame.current?.contentWindow) target.postMessage({ channel: channel.current, type: 'asset-response', id, error: error instanceof Error ? error.message : 'Asset request failed' }, '*');
        }).finally(() => requests.delete(id));
      }
    };
    window.addEventListener('message', handler);
    return () => { window.removeEventListener('message', handler); requests.forEach((request) => request.abort()); };
  }, [report.path, onEdited, loaded?.manifest]);

  useEffect(() => {
    if (!active || removed || edited || loaded?.version === report.version) { setBusy(false); return; }
    const controller = new AbortController();
    setBusy(true);
    setError(false);
    void readReport(report.path, controller.signal).then((html) => {
      if (controller.signal.aborted) return;
      const isolated = isolatedReport(html, channel.current, themeRef.current);
      setBusy(false);
      setLoaded({ version: report.version, html: isolated, manifest: assetManifest(html) });
    }).catch(() => {
      if (!controller.signal.aborted) setError(true);
    }).finally(() => {
      if (!controller.signal.aborted) setBusy(false);
    });
    return () => controller.abort();
  }, [report.path, report.version, loaded?.version, edited, retry, removed, active]);

  function resizeFrame() {
    frame.current?.contentWindow?.postMessage({ channel: channel.current, type: 'set-theme', theme }, '*');
    frame.current?.contentWindow?.postMessage({ channel: channel.current, type: 'resize' }, '*');
    if (active) frame.current?.contentWindow?.postMessage({ channel: channel.current, type: 'set-report-rank', rank }, '*');
    if (active && binFocus) frame.current?.contentWindow?.postMessage({ channel: channel.current, type: 'focus-bin', ...binFocus }, '*');
  }
  useEffect(() => { if (active) resizeFrame(); }, [active, loaded?.version, binFocus, rank]);
  useEffect(() => {
    frame.current?.contentWindow?.postMessage({ channel: channel.current, type: 'set-theme', theme }, '*');
  }, [theme]);

  function reload() {
    if (edited && !window.confirm('Reloading clears the manual bin assignments in this tab. Export them from the report before continuing. Reload now?')) return;
    setEdited(false); onEdited(report.path, false);
    setLoaded(undefined); setRetry((n) => n + 1);
  }

  return <section className="report-pane" hidden={!active} role="tabpanel" id={`panel-${encodeURIComponent(report.sample)}`} aria-label={`${report.sample} report`}>
    {removed && <div className="notice">This report was removed from S3. Your open manual assignments are retained here until you leave.</div>}
    {edited && <div className="notice">Manual assignments are held in this tab. Export them from the report before closing. Automatic replacement is paused.</div>}
    {stale && edited && <div className="notice">A newer report is available. <button onClick={reload}>Load latest report</button></div>}
    {busy && !loaded && <div className="load-status" role="status">Loading report…</div>}
    {error && <div className="notice error" role="alert">Could not load this report. It may have changed or your access may have expired. <button onClick={() => setRetry((n) => n + 1)}>Retry</button></div>}
    {loaded && <iframe key={loaded.version} ref={frame} title={`MetaHopper report — ${report.sample}`} srcDoc={loaded.html} sandbox="allow-scripts allow-downloads allow-modals" referrerPolicy="no-referrer" onLoad={resizeFrame} />}
  </section>;
}

