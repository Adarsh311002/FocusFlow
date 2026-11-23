import { type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react';

function cx(...parts: readonly (string | false | undefined)[]): string {
  return parts.filter((part): part is string => typeof part === 'string' && part !== '').join(' ');
}

type ButtonVariant = 'primary' | 'ghost' | 'danger';

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-2 rounded-full px-5 py-2.5 text-sm font-medium transition duration-200 disabled:cursor-not-allowed disabled:opacity-50';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-focus text-focus-ink shadow-glow hover:brightness-110 active:scale-[0.98]',
  ghost: 'border border-line bg-surface text-ink hover:bg-surface-strong',
  danger: 'border border-danger/40 bg-danger/10 text-danger hover:bg-danger/20',
};

export function buttonClass(variant: ButtonVariant = 'primary', extra?: string): string {
  return cx(BUTTON_BASE, BUTTON_VARIANTS[variant], extra);
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
}

export function Button({ variant = 'primary', className, type = 'button', ...rest }: ButtonProps) {
  return <button type={type} className={buttonClass(variant, className)} {...rest} />;
}

/** The glass surface every panel sits on. */
export function Card({
  className,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { readonly children?: ReactNode }) {
  return (
    <div
      className={cx(
        'rounded-2xl border border-line bg-surface p-5 shadow-card backdrop-blur-xl',
        className,
      )}
      {...rest}
    />
  );
}

/** Small uppercase label above a block of content. */
export function Eyebrow({ children }: { readonly children: ReactNode }) {
  return <p className="text-xs font-medium tracking-[0.18em] text-muted uppercase">{children}</p>;
}

export const INPUT_CLASS =
  'w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted/70 focus:border-focus focus:outline-none';
