import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PageLayout({ children, narrow = false, className }: {
  children: ReactNode;
  narrow?: boolean;
  className?: string;
}) {
  return <div className={cn("wf-page", narrow && "wf-page-narrow", className)}>{children}</div>;
}

export function PageHeader({ title, description, actions, children }: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="wf-page-header">
      <div className="wf-heading-row">
        <div className="min-w-0">
          <h1 className="wf-page-title">{title}</h1>
          {description ? <div className="wf-page-description">{description}</div> : null}
        </div>
        {actions ? <div className="wf-page-actions">{actions}</div> : null}
      </div>
      {children}
    </header>
  );
}

export function SectionHeader({ title, description, actions }: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="wf-section-header">
      <div className="min-w-0">
        <h2 className="wf-section-title">{title}</h2>
        {description ? <p className="wf-page-description">{description}</p> : null}
      </div>
      {actions ? <div className="wf-page-actions">{actions}</div> : null}
    </div>
  );
}
