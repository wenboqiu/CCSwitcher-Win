import { useEffect, useState, useCallback, useRef } from 'react';
import type { AppState, UsageSummary, UsageLimits, CostSummary } from '../../shared/types';
import AccountList from './components/AccountList';
import UsagePanel from './components/UsagePanel';

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [stats, setStats] = useState<UsageSummary | null>(null);
  const [cost, setCost] = useState<CostSummary | null>(null);
  const [limits, setLimits] = useState<UsageLimits | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const appRef = useRef<HTMLDivElement>(null);

  const loadAll = useCallback(async () => {
    const [s, st, l] = await Promise.all([
      window.electronAPI.getState(),
      window.electronAPI.getStats(),
      window.electronAPI.getUsageLimits(),
    ]);
    setState(s);
    setStats(st);
    setLimits(l.success ? (l.data ?? null) : null);

    // Cost needs the LiteLLM pricing table (network on first load) — fetch it
    // separately so it never delays the rest of the UI.
    window.electronAPI.getCost().then(setCost).catch(() => setCost(null));
  }, []);

  useEffect(() => {
    loadAll();
    const unsub = window.electronAPI.onStateUpdated((s) => setState(s));
    return unsub;
  }, [loadAll]);

  // Keep the window height matched to the content as it changes (e.g. when cost
  // loads, an account is added, or an error banner appears).
  useEffect(() => {
    const el = appRef.current;
    if (!el) return;
    // el is the unconstrained inner wrapper, so its height is the true content
    // height (never clamped by the window). +2 covers the .app 1px top+bottom border.
    const report = () => window.electronAPI.resizePopup(el.offsetHeight + 2);
    const ro = new ResizeObserver(report);
    ro.observe(el);
    report();
    return () => ro.disconnect();
  }, []);

  const withBusy = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      setError(null);
      try {
        await fn();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
        await loadAll();
      }
    },
    [loadAll],
  );

  const handleSwitch = (id: string) =>
    withBusy(async () => {
      const r = await window.electronAPI.switchAccount(id);
      if (!r.success) throw new Error(r.error);
    });

  const handleAdd = () =>
    withBusy(async () => {
      const r = await window.electronAPI.addAccount();
      if (!r.success) throw new Error(r.error);
    });

  const handleRemove = (id: string) =>
    withBusy(async () => {
      const r = await window.electronAPI.removeAccount(id);
      if (!r.success) throw new Error(r.error);
    });

  const handleReauth = (id: string) =>
    withBusy(async () => {
      const r = await window.electronAPI.reauthenticate(id);
      if (!r.success) throw new Error(r.error);
    });

  return (
    <div className="app">
      <div className="app-inner" ref={appRef}>
        <header className="app-header">
          <span className="app-title">CCSwitcher</span>
          <button className="close-btn" title="Close" onClick={() => window.electronAPI.closePopup()}>
            ×
          </button>
        </header>

        {error && (
          <div className="error-banner" onClick={() => setError(null)}>
            {error}
          </div>
        )}

        {busy && <div className="busy-bar" />}

        <div className="app-body">
          <AccountList
            accounts={state?.accounts ?? []}
            activeId={state?.activeAccountId ?? null}
            busy={busy}
            onSwitch={handleSwitch}
            onAdd={handleAdd}
            onRemove={handleRemove}
            onReauth={handleReauth}
          />

          {stats && <UsagePanel stats={stats} limits={limits} cost={cost} />}
        </div>
      </div>
    </div>
  );
}
