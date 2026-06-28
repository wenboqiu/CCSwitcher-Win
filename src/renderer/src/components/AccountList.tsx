import type { Account } from '../../../shared/types';

interface Props {
  accounts: Account[];
  activeId: string | null;
  busy: boolean;
  onSwitch: (id: string) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onReauth: (id: string) => void;
}

const SUB_LABEL: Record<string, string> = {
  pro: 'Pro',
  max: 'Max',
  free: 'Free',
};

export default function AccountList({ accounts, activeId, busy, onSwitch, onAdd, onRemove, onReauth }: Props) {
  return (
    <section className="section">
      <div className="section-header">Accounts</div>

      {accounts.length === 0 && (
        <p className="empty-hint">
          Login in terminal first:<br />
          <code>claude auth login</code><br />
          Then click Capture Current.
        </p>
      )}

      {accounts.map((acc) => {
        const isActive = acc.id === activeId;
        return (
          <div key={acc.id} className={`account-row ${isActive ? 'active' : ''}`}>
            <div className="account-info">
              <span className="account-email">{acc.email}</span>
              {acc.subscriptionType && (
                <span className={`badge badge-${acc.subscriptionType}`}>
                  {SUB_LABEL[acc.subscriptionType] ?? acc.subscriptionType}
                </span>
              )}
            </div>
            <div className="account-actions">
              {isActive ? (
                <span className="active-label">Active</span>
              ) : (
                <button
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => onSwitch(acc.id)}
                >
                  Switch
                </button>
              )}
              <button
                className="btn btn-ghost"
                disabled={busy}
                title="Re-authenticate"
                onClick={() => onReauth(acc.id)}
              >
                ↻
              </button>
              {!isActive && (
                <button
                  className="btn btn-danger"
                  disabled={busy}
                  title="Remove account"
                  onClick={() => onRemove(acc.id)}
                >
                  ✕
                </button>
              )}
            </div>
          </div>
        );
      })}

      <button className="btn btn-add" disabled={busy} title="Capture currently active Claude session" onClick={onAdd}>
        Capture Current
      </button>
    </section>
  );
}
