import { initials } from '../lib/profile';

/** A small round avatar: the person's uploaded picture if present, else their
 * initials in Gilt's gold ring (g-av). Shared by
 * comments, member lists, etc. */
export default function Avatar({
  name,
  src,
  size = 28,
  title,
}: {
  name: string;
  src?: string | null;
  size?: number;
  title?: string;
}) {
  if (src) {
    return (
      <img
        src={src}
        alt={name}
        title={title ?? name}
        width={size}
        height={size}
        style={{ width: size, height: size }}
        className="rounded-full object-cover shrink-0 border border-gilt-a"
      />
    );
  }
  // Gilt's initials avatar: gold initials in a gilt ring.
  return (
    <div
      title={title ?? name}
      style={{ width: size, height: size, fontSize: Math.max(8, Math.round(size * 0.39)) }}
      className="g-av select-none"
    >
      {initials(name)}
    </div>
  );
}
