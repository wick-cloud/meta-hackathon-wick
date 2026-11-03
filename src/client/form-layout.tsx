import type { HTMLAttributes, ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react';
import { Link, PageHeader } from './components';

type ContentProps = { children: ReactNode; className?: string };
const classes = (base: string, extra?: string) => (extra ? `${base} ${extra}` : base);

export function FormPage({
  title,
  description,
  eyebrow,
  back,
  step,
  actions,
  children,
  className,
}: ContentProps & {
  title: string;
  description?: string;
  eyebrow?: string;
  back?: { href: string; label: string };
  step?: string;
  actions?: ReactNode;
}) {
  return (
    <div className={classes('form-page', className)}>
      {back && (
        <Link href={back.href} className="back-link">
          <ChevronLeft size={16} aria-hidden="true" />
          {back.label}
        </Link>
      )}
      <PageHeader title={title} description={description} eyebrow={eyebrow}>
        {actions}
        {step && (
          <span className="form-step" aria-current="step">
            {step}
          </span>
        )}
      </PageHeader>
      {children}
    </div>
  );
}

export function FormLayout({ children, aside, className }: ContentProps & { aside?: ReactNode }) {
  return (
    <div className={classes(`form-layout${aside ? '' : ' form-layout-single'}`, className)}>
      <div className="form-main">{children}</div>
      {aside && <aside className="form-aside">{aside}</aside>}
    </div>
  );
}

export function FormPanel({
  children,
  className,
  ...props
}: ContentProps & HTMLAttributes<HTMLElement>) {
  return (
    <section {...props} className={classes('form-panel', className)}>
      {children}
    </section>
  );
}

export function FormSection({
  title,
  description,
  children,
  className,
}: ContentProps & {
  title?: string;
  description?: string;
}) {
  return (
    <div className={classes('form-section', className)}>
      {(title || description) && (
        <div className="form-section-heading">
          {title && <h2>{title}</h2>}
          {description && <p>{description}</p>}
        </div>
      )}
      {children}
    </div>
  );
}

export function FormSummary({
  title,
  description,
  children,
  className,
}: ContentProps & {
  title: string;
  description?: string;
}) {
  return (
    <section className={classes('form-summary', className)} aria-label={title}>
      <div className="form-summary-heading">
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {children}
    </section>
  );
}

export function FormSummaryRows({
  items,
}: {
  items: ReadonlyArray<{ label: string; value: ReactNode }>;
}) {
  return (
    <dl className="form-summary-rows">
      {items.map(({ label, value }) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function FormTotal({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="form-total">
      <span>{label}</span>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}

export function FormNotice({ icon, children, className }: ContentProps & { icon?: ReactNode }) {
  return (
    <div className={classes('form-notice', className)}>
      {icon && (
        <span className="form-notice-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <div>{children}</div>
    </div>
  );
}

export function FormDisclosure({
  title,
  icon,
  children,
  className,
}: ContentProps & {
  title: string;
  icon?: ReactNode;
}) {
  return (
    <details className={classes('form-disclosure', className)}>
      <summary>
        {icon && (
          <span className="form-disclosure-icon" aria-hidden="true">
            {icon}
          </span>
        )}
        <span>{title}</span>
      </summary>
      <div className="form-disclosure-content">{children}</div>
    </details>
  );
}

export function FormActions({ children, className }: ContentProps) {
  return <div className={classes('form-actions', className)}>{children}</div>;
}
