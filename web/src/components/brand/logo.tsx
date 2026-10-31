import { APP_NAME } from "@morrow/contracts";
import { cn } from "@/lib/cn";
import { CloudMark } from "./cloud-mark";

/** Mark plus name, for headers. */
export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 text-[16px] font-[650] tracking-[-0.03em] text-text", className)}>
      <CloudMark className="size-6" title="" />
      {APP_NAME}
    </span>
  );
}
