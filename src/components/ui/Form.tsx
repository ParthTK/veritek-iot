import { useId } from 'react';
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { cn } from '@/utils/cn';

interface FieldProps {
  label: string;
  htmlFor: string;
  required?: boolean;
  error?: string;
  hint?: ReactNode;
  /** Unit rendered to the right of the label, e.g. "V", "kWh". */
  unit?: string;
  children: ReactNode;
  className?: string;
}

export function Field({
  label,
  htmlFor,
  required,
  error,
  hint,
  unit,
  children,
  className,
}: FieldProps) {
  return (
    <div className={cn('min-w-0', className)}>
      <label htmlFor={htmlFor} className="field-label">
        {label}
        {required ? <span className="ml-0.5 text-error-500">*</span> : null}
        {unit ? <span className="ml-1 font-normal text-gray-400">({unit})</span> : null}
      </label>
      {children}
      {error ? (
        <p className="mt-1 text-theme-2xs text-error-600" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="mt-1 text-theme-2xs text-gray-500">{hint}</p>
      ) : null}
    </div>
  );
}

interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  /** Leading glyph rendered inside the control. */
  icon?: ReactNode;
  /** Trailing control, e.g. a show/hide password button. */
  trailing?: ReactNode;
}

export function TextInput({ invalid, icon, trailing, className, ...rest }: TextInputProps) {
  return (
    <div className="relative">
      {icon ? (
        <span
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
          aria-hidden
        >
          {icon}
        </span>
      ) : null}
      <input
        className={cn(
          'field-input',
          icon && 'pl-9',
          trailing && 'pr-10',
          invalid && 'field-error',
          className,
        )}
        aria-invalid={invalid || undefined}
        {...rest}
      />
      {trailing ? (
        <span className="absolute right-2 top-1/2 -translate-y-1/2">{trailing}</span>
      ) : null}
    </div>
  );
}

interface SelectInputProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
}

export function SelectInput({ invalid, className, children, ...rest }: SelectInputProps) {
  return (
    <select
      className={cn('field-input appearance-none bg-no-repeat pr-8', invalid && 'field-error', className)}
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%23667085' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")",
        backgroundPosition: 'right 0.65rem center',
        backgroundSize: '14px',
      }}
      aria-invalid={invalid || undefined}
      {...rest}
    >
      {children}
    </select>
  );
}

interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
  /** Hide the text and expose the label only to assistive tech. */
  hideLabel?: boolean;
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
  hideLabel,
}: ToggleProps) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      {!hideLabel ? (
        <div className="min-w-0">
          <label htmlFor={id} className="block text-theme-sm font-medium text-gray-700">
            {label}
          </label>
          {description ? (
            <p className="mt-0.5 text-theme-xs text-gray-500">{description}</p>
          ) : null}
        </div>
      ) : null}
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={hideLabel ? label : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50',
          checked ? 'bg-brand-600' : 'bg-gray-300',
        )}
      >
        <span
          className={cn(
            'inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform',
            checked ? 'translate-x-[1.15rem]' : 'translate-x-1',
          )}
        />
      </button>
    </div>
  );
}

/** Selectable card used by the report generator's radio groups. */
export function RadioCard({
  checked,
  onSelect,
  icon,
  title,
  description,
  name,
}: {
  checked: boolean;
  onSelect: () => void;
  icon?: ReactNode;
  title: string;
  description?: string;
  name: string;
}) {
  const id = useId();
  return (
    <label
      htmlFor={id}
      className={cn(
        'flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 transition-colors',
        checked ? 'border-brand-500 bg-brand-25 ring-1 ring-brand-500' : 'border-gray-200 hover:bg-gray-50',
      )}
    >
      <input
        id={id}
        type="radio"
        name={name}
        checked={checked}
        onChange={onSelect}
        className="mt-0.5 h-3.5 w-3.5 accent-brand-600"
      />
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-theme-sm font-medium text-gray-800">
          {icon}
          {title}
        </span>
        {description ? (
          <span className="mt-0.5 block text-theme-xs text-gray-500">{description}</span>
        ) : null}
      </span>
    </label>
  );
}
