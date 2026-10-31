"use client";

import { Toast as Base } from "@base-ui/react/toast";
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Button } from "./button";
import { clearCarriedToast, peekCarriedToast, SEEN_AFTER_MS } from "./carried-toast";
import styles from "./toast.module.css";

/** One manager for the whole app, so code outside React can raise toasts too. */
export const toastManager = Base.createToastManager();

type ToastOptions = {
  description?: ReactNode;
  /** ms before it dismisses itself; 0 keeps it until closed. */
  timeout?: number;
  /** A single action, e.g. Undo. */
  action?: { label: string; onClick: () => void };
  /** Same id replaces the toast in place instead of stacking a new one. */
  id?: string;
};

type Kind = "neutral" | "success" | "error" | "warning" | "info";

function show(kind: Kind, title: ReactNode, options: ToastOptions = {}) {
  const { action, ...rest } = options;
  return toastManager.add({
    title,
    type: kind,
    priority: kind === "error" ? "high" : "low",
    ...rest,
    actionProps: action ? { children: action.label, onClick: action.onClick } : undefined,
  });
}

/** `toast("Saved")`, `toast.error("Couldn't connect", { description })`. */
export const toast = Object.assign((title: ReactNode, options?: ToastOptions) => show("neutral", title, options), {
  success: (title: ReactNode, options?: ToastOptions) => show("success", title, options),
  error: (title: ReactNode, options?: ToastOptions) => show("error", title, options),
  warning: (title: ReactNode, options?: ToastOptions) => show("warning", title, options),
  info: (title: ReactNode, options?: ToastOptions) => show("info", title, options),
  dismiss: (id: string) => toastManager.close(id),
});

const ICON: Record<string, ReactNode> = {
  success: <CircleCheck className="text-success" />,
  error: <CircleAlert className="text-danger" />,
  warning: <TriangleAlert className="text-warning" />,
  info: <Info className="text-info" />,
};

/** The stack, top right under the topbar (t3code), at opencode's geometry: 320px, 12px apart, 5s. */
export function Toaster() {
  // A message a flow left behind before reloading the page on purpose (see carried-toast.ts). A tick later, because
  // Toast.Provider (the parent) starts listening to the manager only after this child's effect has run.
  useEffect(() => {
    let seen: number | undefined;
    const shown = window.setTimeout(() => {
      const carried = peekCarriedToast();
      if (!carried) return;
      show(carried.kind, carried.title);
      seen = window.setTimeout(clearCarriedToast, SEEN_AFTER_MS);
    }, 0);
    return () => {
      window.clearTimeout(shown);
      window.clearTimeout(seen);
    };
  }, []);
  return (
    <Base.Portal>
      <Base.Viewport className={styles.viewport}>
        <ToastList />
      </Base.Viewport>
    </Base.Portal>
  );
}

function ToastList() {
  const { toasts } = Base.useToastManager();
  return toasts.map((item) => {
    const icon = item.type ? ICON[item.type] : undefined;
    return (
      <Base.Root key={item.id} toast={item} swipeDirection={["up", "right"]} className={styles.toast}>
        <Base.Content className={cn(styles.content, icon && styles.withIcon)}>
          {icon ? <span className={styles.icon}>{icon}</span> : null}
          <div className="min-w-0">
            <Base.Title className="truncate text-[13.5px] leading-5 font-[550] tracking-[-0.04px] text-text" />
            <Base.Description className="text-[13.5px] leading-5 tracking-[-0.04px] text-muted text-pretty" />
            {item.actionProps ? (
              <Base.Action render={<Button size="xs" variant="secondary" className="mt-2.5" />} />
            ) : null}
          </div>
          <Base.Close
            aria-label="Dismiss"
            className="grid size-5 place-items-center rounded-[5px] text-muted transition-colors duration-150 hover:bg-fill-hover hover:text-text"
          >
            <X className="size-3.5" />
          </Base.Close>
        </Base.Content>
      </Base.Root>
    );
  });
}
