"use client";

import { Toast } from "@base-ui/react/toast";
import type { ReactNode } from "react";
import { Toaster, toastManager } from "./toast";
import { TooltipProvider } from "./tooltip";

/** App-wide UI context: tooltip timing and the toast stack. */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider>
      <Toast.Provider toastManager={toastManager} limit={3} timeout={5000}>
        {children}
        <Toaster />
      </Toast.Provider>
    </TooltipProvider>
  );
}
