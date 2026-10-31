import type { ReactNode } from "react";
import { CloudMark } from "@/components/brand/cloud-mark";
import { GlassPanel } from "@/components/ui/card";
import { cn } from "@/lib/cn";

type AuthCardProps = {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
};

/** The one glass card that floats on the sky for sign-in and invites. */
export function AuthCard({ title, description, children, footer, className }: AuthCardProps) {
  return (
    <GlassPanel
      variant="sky"
      padding="none"
      className={cn("w-full max-w-[420px] animate-[rise_0.9s_var(--ease-emphasized)_backwards]", className)}
    >
      <div className="flex flex-col items-center px-6 pt-8 pb-6 text-center sm:px-8">
        <CloudMark className="size-11" title="" />
        <h1 className="mt-5 text-[22px] leading-tight font-[650] tracking-[-0.03em] text-balance">{title}</h1>
        {description ? (
          <p className="mt-2 max-w-[30ch] text-[14.5px] leading-[1.5] text-muted text-balance">{description}</p>
        ) : null}
        <div className="mt-6 flex w-full flex-col gap-3">{children}</div>
      </div>
      {footer ? (
        <div className="border-t border-border px-6 py-3.5 text-center text-[12.5px] leading-[1.5] text-muted sm:px-8">
          {footer}
        </div>
      ) : null}
    </GlassPanel>
  );
}
