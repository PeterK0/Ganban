import type { ReactNode } from 'react';

interface DecoHeadingProps {
  children: ReactNode;
  /** A count shown after the title, muted (the prototype's `.h2 .n`). */
  count?: ReactNode;
  /** The heading element; h2 by default. */
  as?: 'h1' | 'h2' | 'h3' | 'h4' | 'div';
  className?: string;
}

/** Gilt's centred gold deco heading between two diamonds (`g-h2`). */
export default function DecoHeading({ children, count, as: Tag = 'h2', className }: DecoHeadingProps) {
  return (
    <Tag className={className ? `g-h2 ${className}` : 'g-h2'}>
      {children}
      {count !== undefined && count !== null && <span className="n">{count}</span>}
    </Tag>
  );
}
