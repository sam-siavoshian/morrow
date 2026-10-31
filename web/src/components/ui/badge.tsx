import { cva, type VariantProps } from "class-variance-authority";
import { Check, Hand, TriangleAlert } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { RadarSpinner } from "./radar-spinner";
import { ShimmerText } from "./shimmer-text";
import { StatusDot } from "./status-dot";
import { ElapsedTime } from "./timer";

// Soft hue recipe: a wash of the hue over the surface, a hairline of it at
// the edge, and ink mixed toward the text colour so it always reads.
export const badgeVariants = cva(
  "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-capsule px-2.5 text-[12.5px] font-[550] tracking-[-0.005em] whitespace-nowrap tabular-nums [&_svg]:size-3.5 [&_svg]:shrink-0",
  {
    variants: {
      tone: {
        neutral: "bg-fill text-label-secondary shadow-hairline",
        sky: "bg-soft-sky-wash text-soft-sky-ink shadow-[inset_0_0_0_0.5px_var(--color-soft-sky-edge)]",
        mint: "bg-soft-mint-wash text-soft-mint-ink shadow-[inset_0_0_0_0.5px_var(--color-soft-mint-edge)]",
        lemon: "bg-soft-lemon-wash text-soft-lemon-ink shadow-[inset_0_0_0_0.5px_var(--color-soft-lemon-edge)]",
        peach: "bg-soft-peach-wash text-soft-peach-ink shadow-[inset_0_0_0_0.5px_var(--color-soft-peach-edge)]",
        rose: "bg-soft-rose-wash text-soft-rose-ink shadow-[inset_0_0_0_0.5px_var(--color-soft-rose-edge)]",
        lilac: "bg-soft-lilac-wash text-soft-lilac-ink shadow-[inset_0_0_0_0.5px_var(--color-soft-lilac-edge)]",
        outline: "text-muted shadow-hairline",
      },
      size: {
        sm: "h-5 gap-1 px-2 text-[11.5px] [&_svg]:size-3",
        md: "",
      },
    },
    defaultVariants: { tone: "neutral", size: "md" },
  },
);

export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>["tone"]>;

export function Badge({
  tone,
  size,
  className,
  ...props
}: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone, size }), className)} {...props} />;
}

export type AgentStatus = "working" | "approval" | "failed" | "done" | "queued" | "idle";

const STATUS: Record<AgentStatus, { tone: BadgeTone; label: string; icon: ReactNode }> = {
  working: { tone: "sky", label: "Working", icon: <RadarSpinner className="size-3.5" /> },
  approval: { tone: "lemon", label: "Needs approval", icon: <Hand /> },
  failed: { tone: "rose", label: "Failed", icon: <TriangleAlert /> },
  done: { tone: "mint", label: "Done", icon: <Check strokeWidth={2.25} /> },
  queued: { tone: "neutral", label: "Queued", icon: <StatusDot tone="idle" /> },
  idle: { tone: "outline", label: "Idle", icon: <StatusDot tone="idle" /> },
};

type StatusChipProps = Omit<ComponentProps<"span">, "children"> & {
  status: AgentStatus;
  /** Replaces the default word, e.g. "Running tests". */
  label?: string;
  /** Epoch ms the work started; shows a live elapsed time while working. */
  since?: number;
  size?: "sm" | "md";
};

/**
 * What an agent is doing, in one chip. Working shimmers and counts up, like
 * t3code's "Working 42s": live text over spinners.
 */
export function StatusChip({ status, label, since, size, className, ...props }: StatusChipProps) {
  const { tone, label: fallback, icon } = STATUS[status];
  const text = label ?? fallback;
  return (
    <Badge tone={tone} size={size} role="status" className={className} {...props}>
      {icon}
      {status === "working" ? <ShimmerText>{text}</ShimmerText> : <span>{text}</span>}
      {status === "working" && since !== undefined ? (
        <ElapsedTime since={since} className="font-[500] opacity-70" />
      ) : null}
    </Badge>
  );
}
