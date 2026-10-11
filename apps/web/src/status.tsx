import type { HTMLAttributes, PropsWithChildren } from "react";

export type StatusKind = "current" | "stale" | "missing" | "error" | "recheck" | "checking" | "pending";

export function Status({ kind, children, ...props }: PropsWithChildren<{ kind: StatusKind }> & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={`status status--${kind}`} {...props}>
      <span className="status__indicator" aria-hidden="true"><span /></span>
      <span>{children ?? kind}</span>
    </span>
  );
}
