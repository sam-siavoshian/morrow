import { cva, type VariantProps } from "class-variance-authority";
import { CircleAlert, Info, TriangleAlert } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";

// The badge's soft hue recipe at banner size: a wash, a hairline edge, ink that always reads.
const alertVariants = cva(
  "flex items-start gap-2.5 rounded-row px-3.5 py-3 text-[13.5px] leading-[1.45] text-pretty [&>svg]:mt-[1.5px] [&>svg]:size-4 [&>svg]:shrink-0",
  {
    variants: {
      tone: {
        neutral: "bg-fill text-label-secondary shadow-hairline",
        info: "bg-soft-sky-wash text-soft-sky-ink shadow-[inset_0_0_0_0.5px_var(--color-soft-sky-edge)]",
        warning: "bg-soft-lemon-wash text-soft-lemon-ink shadow-[inset_0_0_0_0.5px_var(--color-soft-lemon-edge)]",
        danger: "bg-soft-rose-wash text-soft-rose-ink shadow-[inset_0_0_0_0.5px_var(--color-soft-rose-edge)]",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

const ICON = {
  neutral: <Info />,
  info: <Info />,
  warning: <TriangleAlert />,
  danger: <CircleAlert />,
} as const;

type AlertProps = Omit<ComponentProps<"div">, "title"> &
  VariantProps<typeof alertVariants> & {
    title?: ReactNode;
    /** A button or link on the right, e.g. Retry. */
    action?: ReactNode;
    /** Replaces the tone's icon; `null` shows none. */
    icon?: ReactNode;
  };

/** A short message in the flow of the page: what happened and, if anything, the one thing to do. */
export function Alert({ tone, title, action, icon, className, children, role, ...props }: AlertProps) {
  const resolved = tone ?? "neutral";
  return (
    <div
      role={role ?? (resolved === "danger" ? "alert" : "status")}
      className={cn(alertVariants({ tone }), className)}
      {...props}
    >
      {icon === undefined ? ICON[resolved] : icon}
      <div className="min-w-0 flex-1 text-left">
        {title ? <p className="font-[600] tracking-[-0.006em]">{title}</p> : null}
        {children ? <div className={cn(title && "mt-0.5 opacity-90")}>{children}</div> : null}
      </div>
      {action ? <div className="-my-1 shrink-0 self-center">{action}</div> : null}
    </div>
  );
}
