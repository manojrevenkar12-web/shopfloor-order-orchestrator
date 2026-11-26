export function Loading() {
  return (
    <div className="state" role="status" aria-live="polite">
      <div className="skeleton skeleton-hero" />
      <div className="skeleton-row">
        <div className="skeleton skeleton-cell" />
        <div className="skeleton skeleton-cell" />
        <div className="skeleton skeleton-cell" />
      </div>
      <span className="sr-only">Loading lab results</span>
    </div>
  );
}

export function Failure({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="state state-error" role="alert">
      <p className="state-title">The lab results could not be loaded.</p>
      <p className="state-body mono">{message}</p>
      <button className="button" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

export function Empty() {
  return (
    <div className="state">
      <p className="state-title">No results yet.</p>
      <p className="state-body">
        Run <code>npm run lab -- heldout</code> to generate them.
      </p>
    </div>
  );
}
