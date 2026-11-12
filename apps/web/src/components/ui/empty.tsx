import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "~/lib/utils";

const emptySizeClassName = {
  compact:
    "min-h-64 gap-4 p-6 md:p-10 [&_[data-slot=empty-media]]:mb-0 [--type-title:1.0625rem] [--type-body:0.8125rem]",
  default: "gap-6 p-6 md:p-12",
  hero: "gap-6 p-6 md:p-12 [--type-title:1.5rem] sm:[--type-title:1.875rem]",
} as const;

/**
 * `page` fills the space it is given (a whole route or pane with nothing in it).
 * `well` is the in-flow empty state: a sunken box holding a title, one line and
 * at most one action, sized to its content, for a list or panel with nothing in
 * it yet.
 */
const emptyVariantClassName = {
  page: "flex-1",
  well: "flex-none gap-3 rounded-xl surface-well px-6 py-8 [&_[data-slot=empty-content]]:mt-1 [--type-title:0.9375rem]",
} as const;

function Empty({
  className,
  size = "default",
  variant = "page",
  ...props
}: React.ComponentProps<"div"> & {
  size?: keyof typeof emptySizeClassName;
  variant?: keyof typeof emptyVariantClassName;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col items-center justify-center text-balance text-center",
        variant === "page" && emptySizeClassName[size],
        emptyVariantClassName[variant],
        className,
      )}
      data-slot="empty"
      data-variant={variant}
      {...props}
    />
  );
}

function EmptyHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex max-w-sm flex-col items-center text-center", className)}
      data-slot="empty-header"
      {...props}
    />
  );
}

const emptyMediaVariants = cva(
  "flex shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    defaultVariants: {
      variant: "default",
    },
    variants: {
      variant: {
        default: "bg-transparent",
        icon: "surface-raised relative flex size-9 shrink-0 items-center justify-center rounded-md text-foreground [&_svg:not([class*='size-'])]:size-4.5",
      },
    },
  },
);

function EmptyMedia({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof emptyMediaVariants>) {
  return (
    <div
      className={cn("relative mb-6", className)}
      data-slot="empty-media"
      data-variant={variant}
      {...props}
    >
      {variant === "icon" && (
        <>
          <div
            aria-hidden="true"
            className={cn(
              emptyMediaVariants({ className, variant }),
              "-translate-x-0.5 -rotate-10 pointer-events-none absolute bottom-px origin-bottom-left scale-84 shadow-none",
            )}
          />
          <div
            aria-hidden="true"
            className={cn(
              emptyMediaVariants({ className, variant }),
              "pointer-events-none absolute bottom-px origin-bottom-right translate-x-0.5 rotate-10 scale-84 shadow-none",
            )}
          />
        </>
      )}
      <div className={cn(emptyMediaVariants({ className, variant }))} {...props} />
    </div>
  );
}

function EmptyTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("text-title text-strong-foreground", className)}
      data-slot="empty-title"
      {...props}
    />
  );
}

function EmptyDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <div
      className={cn(
        "text-body text-muted-foreground [&>a:hover]:text-primary [&>a]:underline [&>a]:underline-offset-4 [[data-slot=empty-title]+&]:mt-1 [[data-slot=empty-description]+&]:mt-1",
        className,
      )}
      data-slot="empty-description"
      {...props}
    />
  );
}

function EmptyContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex w-full min-w-0 max-w-sm flex-col items-center gap-4 text-balance text-body",
        className,
      )}
      data-slot="empty-content"
      {...props}
    />
  );
}

export { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyContent, EmptyMedia };
