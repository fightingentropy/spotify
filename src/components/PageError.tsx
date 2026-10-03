type PageErrorProps = {
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
  title?: string;
  compact?: boolean;
};

export function PageError({
  message,
  onRetry,
  retryLabel = "Try again",
  title,
  compact = false,
}: PageErrorProps) {
  if (compact) {
    return (
      <div role="alert">
        <p className="text-sm text-red-300">{message}</p>
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="wf-button mt-4"
          >
            {retryLabel}
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div role="alert" className="wf-panel max-w-md">
      {title ? <h1 className="text-xl font-semibold">{title}</h1> : null}
      <p className={title ? "mt-2 text-sm leading-6 text-white/65" : "text-sm leading-6 text-white/65"}>
        {message}
      </p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="wf-button mt-5"
        >
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}
