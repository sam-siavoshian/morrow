"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { IconButton } from "@/components/ui/icon-button";
import { toast } from "@/components/ui/toast";

/** Copies `value`; the icon turns into a check for a moment. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      toast.error("Couldn't copy", { description: "Your browser blocked the clipboard." });
    }
  };

  return (
    <IconButton label={copied ? "Copied" : label} size="xs" variant="quiet" onClick={() => void copy()}>
      {copied ? <Check className="text-success" strokeWidth={2.25} /> : <Copy />}
    </IconButton>
  );
}
