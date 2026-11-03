import type { ElementType, HTMLAttributes, ReactNode } from 'react';

type CardProps = HTMLAttributes<HTMLElement> & {
  children?: ReactNode;
  /** Adds the four gold corner marks (`g-corners`). */
  corners?: boolean;
  /** A quiet panel without gold (`g-plain`) instead of `g-card`. */
  plain?: boolean;
  /** The element to render; div by default (e.g. 'section', 'button', 'li'). */
  as?: ElementType;
};

/** A Gilt panel: `g-card` (gold border, inset outline), optionally with
 * `g-corners`, or `g-plain`. Other props pass through to the element. */
export default function Card({ corners, plain, as: Tag = 'div', className, children, ...rest }: CardProps) {
  const cls = [plain ? 'g-plain' : 'g-card', corners && !plain ? 'g-corners' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <Tag className={cls} {...rest}>
      {children}
    </Tag>
  );
}
