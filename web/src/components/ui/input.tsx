"use client";

import { Field as BaseField } from "@base-ui/react/field";
import { Input as BaseInput } from "@base-ui/react/input";
import { mergeProps } from "@base-ui/react/merge-props";
import { cva, type VariantProps } from "class-variance-authority";
import {
  useCallback,
  useLayoutEffect,
  useRef,
  type ComponentProps,
  type ReactNode,
  type Ref,
} from "react";
import { cn } from "@/lib/cn";

// Zephium product field: a soft fill, no border, a 1px inset ring only on focus.
// 16px on touch so iOS never zooms the page (t3code).
const fieldVariants = cva(
  [
    "w-full min-w-0 rounded-control-compact bg-field text-text placeholder:text-faint outline-none",
    "text-[16px] sm:text-[15px] tracking-[-0.006em]",
    "transition-[background-color,box-shadow] duration-200 ease-out",
    "hover:bg-[color-mix(in_srgb,var(--color-field),var(--color-field-hover))]",
    "focus-visible:shadow-field-focus focus-visible:outline-none",
    "aria-invalid:shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-danger)_55%,transparent)] data-invalid:shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-danger)_55%,transparent)]",
    "disabled:cursor-not-allowed disabled:opacity-64",
  ],
  {
    variants: {
      size: {
        sm: "h-8 px-2.5 sm:h-7 sm:text-[13.5px]",
        md: "h-10 px-3 sm:h-9",
        lg: "h-11 px-3.5 sm:h-10",
      },
    },
    defaultVariants: { size: "md" },
  },
);

type InputProps = Omit<ComponentProps<typeof BaseInput>, "size" | "className"> &
  VariantProps<typeof fieldVariants> & { className?: string };

export function Input({ className, size, ...props }: InputProps) {
  return <BaseInput data-slot="input" className={cn(fieldVariants({ size }), className)} {...props} />;
}

type TextareaProps = ComponentProps<"textarea"> & {
  /** Grows with its content up to this many rows, then scrolls. */
  maxRows?: number;
};

/**
 * Grows with what is typed: CSS `field-sizing: content` where supported, a
 * measured height elsewhere.
 */
export function Textarea({ className, maxRows = 10, rows = 3, ref, onInput, ...props }: TextareaProps) {
  const local = useRef<HTMLTextAreaElement | null>(null);

  const fit = useCallback(() => {
    const element = local.current;
    if (!element || CSS.supports("field-sizing", "content")) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, []);

  useLayoutEffect(fit, [fit, props.value]);

  const setRef = useCallback(
    (element: HTMLTextAreaElement | null) => {
      local.current = element;
      assignRef(ref, element);
    },
    [ref],
  );

  const own: ComponentProps<"textarea"> = {
    ...props,
    rows,
    onInput: (event) => {
      fit();
      onInput?.(event);
    },
    style: { maxHeight: `calc(${maxRows} * 1.5em + 1.25rem)`, ...props.style },
    className: cn(
      fieldVariants({ size: null }),
      "block resize-none px-3 py-2.5 leading-normal [field-sizing:content]",
      className,
    ),
  };

  // Rendered through Field.Control so a surrounding Field labels it.
  return (
    <BaseField.Control
      data-slot="textarea"
      render={({ ref: fieldRef, ...fieldProps }) => (
        <textarea
          {...mergeProps<"textarea">(fieldProps as ComponentProps<"textarea">, own)}
          ref={(element) => {
            setRef(element);
            assignRef(fieldRef as Ref<HTMLTextAreaElement | null> | undefined, element);
          }}
        />
      )}
    />
  );
}

function assignRef<T>(ref: Ref<T> | undefined, value: T) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

type FieldProps = {
  label: ReactNode;
  description?: ReactNode;
  /** Shown, and the control marked invalid, when set. */
  error?: ReactNode;
  className?: string;
  /** The control: Input, Textarea, Select... */
  children: ReactNode;
};

/** Label, control, help and error wired together (Base UI Field). */
export function Field({ label, description, error, className, children }: FieldProps) {
  return (
    <BaseField.Root invalid={Boolean(error)} className={cn("flex w-full flex-col gap-1.5", className)}>
      <BaseField.Label className="text-[13.5px] font-[550] tracking-[-0.006em] text-label-secondary">
        {label}
      </BaseField.Label>
      {children}
      {error ? (
        <BaseField.Error match className="text-[13px] text-danger">
          {error}
        </BaseField.Error>
      ) : description ? (
        <BaseField.Description className="text-[13px] text-muted">{description}</BaseField.Description>
      ) : null}
    </BaseField.Root>
  );
}
