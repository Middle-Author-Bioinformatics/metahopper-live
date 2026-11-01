import { useCallback, useEffect, useRef, useState } from 'react';
import { Authenticator } from '@aws-amplify/ui-react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { POLL_MS, projectsForGroups, type Project } from '../project';
import { discoverReports } from './storage';
import type { Report } from './catalog';
import ReportFrame from './ReportFrame';

interface AccountProps { email: string; signOut?: () => void }
interface DashboardProps extends AccountProps {
  project: Project;
  projects: readonly Project[];
  onProjectChange: (id: string) => void;
}

export function Dashboard({ email, signOut, project, projects, onProjectChange }: DashboardProps) {
  const [reports, setReports] = useState<Report[]>([]);
  const [cache, setCache] = useState<Report[]>([]);
  const [selected, setSelected] = useState('');
  const [editedPaths, setEditedPaths] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('name');
  const [error, setError] = useState(false);
  const [checked, setChecked] = useState<Date>();
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(false);
  const abort = useRef<AbortController | undefined>(undefined);
  const tabs = useRef<HTMLDivElement>(null);
  const recentlyUsed = useRef(new Map<string, number>());

  const refresh = useCallback(async () => {
    if (abort.current && !abort.current.signal.aborted) return;
    const controller = new AbortController();
    abort.current = controller;
    setRefreshing(true);
    try {
      const next = await discoverReports(project, controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      setReports(next); setChecked(new Date()); setError(false);
    } catch {
      if (mounted.current && !controller.signal.aborted) setError(true);
    } finally {
      if (abort.current === controller) {
        abort.current = undefined;
        if (mounted.current) setRefreshing(false);
      }
    }
  }, [project]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const visibleRefresh = () => { if (!document.hidden) void refresh(); };
    const timer = window.setInterval(visibleRefresh, POLL_MS);
    document.addEventListener('visibilitychange', visibleRefresh);
    window.addEventListener('focus', visibleRefresh);
    window.addEventListener('online', visibleRefresh);
    return () => {
      mounted.current = false; abort.current?.abort(); clearInterval(timer);
      document.removeEventListener('visibilitychange', visibleRefresh);
      window.removeEventListener('focus', visibleRefresh);
      window.removeEventListener('online', visibleRefresh);
    };
  }, [refresh]);

  const selectReport = useCallback((report: Report) => {
    recentlyUsed.current.set(report.path, performance.now());
    setSelected(report.path);
    setCache((previous) => {
      // Never reorder mounted frames: moving an iframe in the DOM can reload it.
      if (previous.some((item) => item.path === report.path)) return previous;
      const next = [...previous, report];
      // Keep four recent frames, plus any frames with manual assignments.
      while (next.length > 4) {
        const oldest = next.filter((item) => item.path !== report.path && !editedPaths.has(item.path))
          .sort((a, b) => (recentlyUsed.current.get(a.path) ?? 0) - (recentlyUsed.current.get(b.path) ?? 0))[0];
        const victim = oldest ? next.findIndex((item) => item.path === oldest.path) : -1;
        if (victim < 0) break;
        next.splice(victim, 1);
      }
      return next;
    });
  }, [editedPaths]);

  useEffect(() => {
    if (!checked) return;
    const paths = new Set(reports.map((item) => item.path));
    setCache((previous) => previous.filter((item) => paths.has(item.path) || editedPaths.has(item.path)));
    if (!paths.has(selected) && !editedPaths.has(selected)) {
      if (reports[0]) selectReport(reports[0]);
      else setSelected('');
    }
  }, [reports, checked, selected, editedPaths, selectReport]);

  const onEdited = useCallback((path: string, edited: boolean) => {
    setEditedPaths((previous) => {
      if (previous.has(path) === edited) return previous;
      const next = new Set(previous);
      if (edited) next.add(path); else next.delete(path);
      return next;
    });
  }, []);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (editedPaths.size) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [editedPaths]);

  useEffect(() => {
    tabs.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selected]);

  const byPath = new Map(reports.map((report) => [report.path, report]));
  const available = [...reports, ...cache.filter((item) => !byPath.has(item.path) && editedPaths.has(item.path))];
  const visible = available.filter((item) => item.sample.toLowerCase().includes(query.trim().toLowerCase())).sort((a, b) =>
    sort === 'updated' ? (b.lastModified?.getTime() ?? 0) - (a.lastModified?.getTime() ?? 0) : a.sample.localeCompare(b.sample, undefined, { numeric: true }));

  function navigate(event: React.KeyboardEvent, index: number) {
    let target = index;
    if (event.key === 'ArrowRight') target = (index + 1) % visible.length;
    else if (event.key === 'ArrowLeft') target = (index + visible.length - 1) % visible.length;
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = visible.length - 1;
    else return;
    event.preventDefault(); selectReport(visible[target]);
    (tabs.current?.querySelectorAll('button')[target] as HTMLButtonElement)?.focus();
  }

  function leave() {
    if (editedPaths.size && !window.confirm('Sign out and discard manual bin assignments? Export them from each report first.')) return;
    signOut?.();
  }

  function switchProject(id: string) {
    if (id === project.id) return;
    if (editedPaths.size && !window.confirm('Switch projects and discard manual bin assignments? Export them from each report first.')) return;
    onProjectChange(id);
  }

  return <div className="dashboard">
    <header className="topbar"><div className="identity"><img src="/mab-logo.png" alt="Middle Author Bioinformatics" /><span className="divider" /><div><h1>MetaHopper <span>reports</span></h1>{projects.length > 1 ? <select className="project-picker" aria-label="Project" value={project.id} onChange={(event) => switchProject(event.target.value)}>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select> : <p>{project.name}</p>}</div></div><div className="account"><span>{email}</span><button onClick={leave}>Sign out</button></div></header>
    <div className="catalog-bar"><div className="sample-title"><strong>Samples</strong><span className="count">{reports.length}</span></div><input type="search" aria-label="Find a sample" placeholder="Find a sample…" value={query} onChange={(e) => setQuery(e.target.value)} /><select aria-label="Sort samples" value={sort} onChange={(e) => setSort(e.target.value)}><option value="name">Sample name</option><option value="updated">Recently updated</option></select><div className="sync-status" role="status"><span className={`dot ${error ? 'offline' : ''}`} />{refreshing ? 'Checking…' : error ? 'Update failed' : checked ? `Checked ${checked.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Connecting…'}<span className="sync-detail"> · every 30s</span></div><button onClick={() => void refresh()} disabled={refreshing} aria-label="Refresh sample list">Refresh</button></div>
    {error && <div className="notice error" role="alert">Unable to refresh reports. Check your connection and retry. If this persists, your administrator should check your project access.</div>}
    <div className="tabs-wrap"><button className="scroll-arrow" aria-label="Scroll samples left" onClick={() => tabs.current?.scrollBy({ left: -320, behavior: 'smooth' })}>‹</button><div className="sample-tabs" ref={tabs} role="tablist" aria-label="Samples">{visible.map((report, i) => <button key={report.path} role="tab" aria-selected={selected === report.path} aria-controls={`panel-${encodeURIComponent(report.sample)}`} tabIndex={selected === report.path || (!visible.some((item) => item.path === selected) && i === 0) ? 0 : -1} onClick={() => selectReport(report)} onKeyDown={(e) => navigate(e, i)}>{report.sample}{!byPath.has(report.path) && <small>removed</small>}{editedPaths.has(report.path) && <span title="Manual assignments in this tab" aria-label="Manual assignments"> •</span>}</button>)}</div><button className="scroll-arrow" aria-label="Scroll samples right" onClick={() => tabs.current?.scrollBy({ left: 320, behavior: 'smooth' })}>›</button></div>
    {query && !visible.length && <div className="notice">No sample matches “{query}”. <button onClick={() => setQuery('')}>Clear search</button></div>}
    <main className="workspace">
      {!selected && <div className="empty"><div className="empty-icon">M</div><h2>{checked ? 'Waiting for reports' : error ? 'Reports unavailable' : 'Finding your samples…'}</h2><p>{checked ? 'Completed reports will appear here automatically.' : error ? 'Use Refresh to try again.' : 'Connecting to your project.'}</p></div>}
      {cache.map((cached) => <ReportFrame key={cached.path} report={byPath.get(cached.path) ?? cached} active={selected === cached.path} removed={!byPath.has(cached.path)} onEdited={onEdited} />)}
    </main>
  </div>;
}

export function ProjectSession({ email, signOut }: AccountProps) {
  const [projects, setProjects] = useState<readonly Project[]>();
  const [projectId, setProjectId] = useState('');
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(false);
    void fetchAuthSession().then((session) => {
      if (!cancelled) setProjects(projectsForGroups(session.tokens?.idToken?.payload['cognito:groups']));
    }).catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [retry]);

  const project = projects?.find((item) => item.id === projectId) ?? projects?.[0];
  if (project && projects) return <Dashboard key={project.id} email={email} signOut={signOut} project={project} projects={projects} onProjectChange={setProjectId} />;

  return <div className="dashboard">
    <header className="topbar"><h1>MetaHopper <span>reports</span></h1><div className="account"><span>{email}</span><button onClick={signOut}>Sign out</button></div></header>
    <main className="workspace"><div className="empty">
      <h2>{error ? 'Could not check project access' : projects ? 'No project access yet' : 'Checking project access…'}</h2>
      <p>{error ? 'Please retry or sign in again.' : projects ? 'Ask your administrator to assign your account to a project, then sign out and sign back in.' : 'Loading your projects.'}</p>
      {error && <button onClick={() => setRetry((value) => value + 1)}>Retry</button>}
    </div></main>
  </div>;
}

export default function App() {
  return <Authenticator hideSignUp components={{ Header: () => <div className="login-heading"><img src="/mab-logo.png" alt="Middle Author Bioinformatics" /><h1>MetaHopper reports</h1><p>Sign in to explore your project.</p></div> }}>
    {({ user, signOut }) => <ProjectSession key={user?.userId} email={user?.signInDetails?.loginId ?? user?.username ?? ''} signOut={signOut} />}
  </Authenticator>;
}
