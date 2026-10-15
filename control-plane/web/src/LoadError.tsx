export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div className="form-alert form-alert-error load-error" role="alert">
    <span>{message}</span>
    <button type="button" className="button button-secondary" onClick={onRetry}>Retry</button>
  </div>;
}
