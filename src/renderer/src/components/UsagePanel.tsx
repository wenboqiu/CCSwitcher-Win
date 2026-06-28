import type { UsageSummary, UsageLimits, CostSummary } from '../../../shared/types';

interface Props {
  stats: UsageSummary;
  limits: UsageLimits | null;
  cost: CostSummary | null;
}

export default function UsagePanel({ stats, limits, cost }: Props) {
  return (
    <section className="section">
      <div className="section-header">Usage</div>

      {limits && (
        <div className="limits-row">
          {limits.fiveHourUtilization !== undefined && (
            <LimitBar label="5h window" pct={limits.fiveHourUtilization} resetAt={limits.fiveHourResetAt} />
          )}
          {limits.sevenDayUtilization !== undefined && (
            <LimitBar label="Weekly" pct={limits.sevenDayUtilization} resetAt={limits.sevenDayResetAt} />
          )}
        </div>
      )}

      <div className="stats-grid">
        <StatCell label="Today msgs" value={stats.todayMessages} />
        <StatCell label="Today sessions" value={stats.todaySessionCount} />
        <StatCell label="Week msgs" value={stats.weeklyMessages} />
        <StatCell label="Week tools" value={stats.weeklyToolCalls} />
      </div>

      {cost?.pricingAvailable && (
        <div className="stats-grid cost-grid">
          <StatCell label="Today cost" value={fmtUSD(cost.todayCost)} />
          <StatCell label="Today tokens" value={fmtTokens(cost.todayTokens)} />
          <StatCell label="Week cost" value={fmtUSD(cost.weekCost)} />
          <StatCell label="Total cost" value={fmtUSD(cost.totalCost)} />
        </div>
      )}
    </section>
  );
}

function fmtUSD(n: number): string {
  return n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatResetIn(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return 'now';
  const totalMin = Math.floor(diff / 60_000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${Math.max(mins, 1)}m`;
}

function LimitBar({ label, pct, resetAt }: { label: string; pct: number; resetAt?: string }) {
  // `pct` is already a 0–100 utilization percentage from /api/oauth/usage.
  const clamped = Math.min(100, Math.max(0, pct));
  const color = clamped >= 90 ? 'var(--danger)' : clamped >= 70 ? 'var(--warning)' : 'var(--accent)';
  return (
    <div className="limit-bar-wrap">
      <div className="limit-bar-label">
        <span>{label}</span>
        <span>
          {Math.round(clamped)}%
          {resetAt && <span className="reset-hint"> · {formatResetIn(resetAt)}</span>}
        </span>
      </div>
      <div className="limit-bar-track">
        <div className="limit-bar-fill" style={{ width: `${clamped}%`, background: color }} />
      </div>
    </div>
  );
}

function StatCell({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="stat-cell">
      <span className="stat-value">{typeof value === 'number' ? value.toLocaleString() : value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}
