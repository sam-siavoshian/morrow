import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

type EmptyStateProps = {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Usually one Button: the next thing to do. */
  action?: ReactNode;
  /** Something drawn behind the content. */
  backdrop?: ReactNode;
  className?: string;
};

/** Nothing here yet, said plainly, with the one action that fixes it. */
export function EmptyState({ icon, title, description, action, backdrop, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "relative isolate flex flex-col items-center justify-center gap-1 overflow-hidden px-6 py-12 text-center",
        className,
      )}
    >
      {backdrop ? <div className="absolute inset-0 -z-10">{backdrop}</div> : null}
      {icon ? (
        <div className="mb-3 grid size-11 place-items-center rounded-control bg-surface text-muted shadow-raised [&_svg]:size-5">
          {icon}
        </div>
      ) : null}
      <h3 className="text-[16px] font-[600] tracking-[-0.016em] text-text">{title}</h3>
      {description ? (
        <p className="max-w-sm text-[14px] leading-[1.5] text-muted text-balance">{description}</p>
      ) : null}
      {action ? <div className="mt-4 flex items-center gap-2">{action}</div> : null}
    </div>
  );
}
