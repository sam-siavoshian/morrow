import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";

type SectionProps = {
  title: ReactNode;
  description?: ReactNode;
  /** Buttons on the right of the title. */
  actions?: ReactNode;
  /** Anything between the title and the group, e.g. a status line. */
  meta?: ReactNode;
  children?: ReactNode;
  className?: string;
  id?: string;
};

/** t3code settings section: a title, then a rounded group of rows. */
export function SettingsSection({ title, description, actions, meta, children, className, id }: SectionProps) {
  return (
    <section id={id} className={cn("scroll-mt-20", className)}>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3 px-1 pb-3">
        <div className="min-w-0">
          <h2 className="text-[15px] font-[600] tracking-[-0.016em] text-text">{title}</h2>
          {description ? <p className="mt-0.5 text-[13.5px] leading-[1.5] text-muted text-pretty">{description}</p> : null}
          {meta ? <div className="mt-2">{meta}</div> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** The rounded group itself; rows inside are split by hairlines. */
export function SettingsGroup({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("overflow-hidden rounded-card bg-surface shadow-raised [&>*+*]:border-t [&>*+*]:border-border", className)}
      {...props}
    />
  );
}

type RowProps = {
  title: ReactNode;
  description?: ReactNode;
  /** Leading icon or avatar. */
  icon?: ReactNode;
  /** The control on the right. */
  control?: ReactNode;
  className?: string;
  children?: ReactNode;
};

/** Title and description on the left, the control on the right; stacks on phones. */
export function SettingsRow({ title, description, icon, control, className, children }: RowProps) {
  return (
    <div className={cn("flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:gap-4", className)}>
      <div className="flex min-w-0 flex-1 items-start gap-3 sm:items-center">
        {icon ? <div className="flex shrink-0 items-center">{icon}</div> : null}
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-[550] tracking-[-0.01em] text-text">{title}</div>
          {description ? <div className="mt-0.5 text-[13px] leading-[1.45] text-muted text-pretty">{description}</div> : null}
          {children}
        </div>
      </div>
      {control ? <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">{control}</div> : null}
    </div>
  );
}
