import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";

interface ActiveWork {
  kind: "run" | "slice-build";
  id: string;
  repositoryId: string;
  repositoryName: string;
  status: string;
}

interface WorkerRestartState {
  pending: { requestedAt: string; changedPaths: string[]; decision: "now" | "after-run" | null } | null;
  activeWork: ActiveWork[];
}

const POLL_MS = 5_000;

/**
 * Docker dev mode only: when worker code changes during a run, the watcher
 * holds the restart and this banner asks whether to restart now (ending the
 * run) or once the work finishes.
 */
export function WorkerRestartBanner({ pollMs = POLL_MS }: { pollMs?: number }) {
  const [state, setState] = useState<WorkerRestartState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(() => {
    api<WorkerRestartState>("/api/worker-restart")
      .then(setState)
      .catch(() => setState(null));
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, pollMs);
    return () => clearInterval(timer);
  }, [refresh, pollMs]);

  const decide = async (decision: "now" | "after-run") => {
    setBusy(true);
    setError("");
    try {
      setState(await api<WorkerRestartState>("/api/worker-restart", { method: "POST", body: JSON.stringify({ decision }) }));
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pending = state?.pending;
  if (!pending) return null;

  if (pending.decision === "now") {
    return (
      <div className="worker-restart-banner" role="status">
        <strong>Restarting the worker…</strong>
        <span>In-progress runs end as interrupted.</span>
      </div>
    );
  }

  const work = state.activeWork;
  const describe = (item: ActiveWork) => (
    <li key={item.id}>
      {item.kind === "run" ? <Link to={`/runs/${item.id}`}>Run {item.id.slice(0, 8)}</Link> : <Link to={`/repositories/${item.repositoryId}/slices`}>Slice build</Link>}{" "}
      for {item.repositoryName} <span className="muted">({item.status})</span>
    </li>
  );

  if (pending.decision === "after-run") {
    return (
      <div className="worker-restart-banner worker-restart-banner-quiet" role="status">
        <span>QA Buddy's worker will restart with new code when the current work finishes.</span>
        <button type="button" className="text-button" disabled={busy} onClick={() => void decide("now")}>
          Restart now instead
        </button>
        {error && <span className="inline-error">{error}</span>}
      </div>
    );
  }

  return (
    <div className="worker-restart-banner" role="alert">
      <div>
        <strong>QA Buddy's worker code changed while work is in progress.</strong>
        <span> The restart is on hold so nothing is interrupted.</span>
        {work.length > 0 && <ul>{work.map(describe)}</ul>}
      </div>
      <div className="worker-restart-actions">
        <button type="button" className="button button-secondary" disabled={busy} onClick={() => void decide("after-run")}>
          Restart when it finishes
        </button>
        <button type="button" className="button button-primary" disabled={busy} onClick={() => void decide("now")}>
          Restart now (ends the run)
        </button>
      </div>
      {error && <span className="inline-error">{error}</span>}
    </div>
  );
}
