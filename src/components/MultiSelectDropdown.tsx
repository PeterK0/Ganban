import { useEffect, useRef, useState } from 'react';

interface MultiSelectDropdownProps<T extends { id: number }> {
  label: string;
  items: T[];
  selectedIds: number[];
  onChange: (selectedIds: number[]) => void;
  getDisplayName: (item: T) => string;
  className?: string;
  emptyMessage?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
}

export default function MultiSelectDropdown<T extends { id: number }>({
  label,
  items,
  selectedIds,
  onChange,
  getDisplayName,
  className = '',
  emptyMessage = 'No options',
  searchable = false,
  searchPlaceholder = 'Search...',
}: MultiSelectDropdownProps<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) {
      setSearch('');
      return;
    }
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const selectedItems = items.filter((it) => selectedIds.includes(it.id));
  const buttonLabel =
    selectedItems.length === 0
      ? label
      : selectedItems.length === 1
      ? getDisplayName(selectedItems[0])
      : `${selectedItems.length} selected`;

  const visibleItems =
    searchable && search.trim()
      ? items.filter((it) =>
          getDisplayName(it).toLowerCase().includes(search.trim().toLowerCase())
        )
      : items;

  const toggle = (id: number) => {
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((sid) => sid !== id));
    } else {
      onChange([...selectedIds, id]);
    }
  };

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        className="g-field flex items-center justify-between gap-2 text-left hover:border-overlay-0"
      >
        <span className="truncate">{buttonLabel}</span>
        <svg
          className="w-4 h-4 flex-shrink-0 text-subtext-0"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d={isOpen ? 'M5 15l7-7 7 7' : 'M19 9l-7 7-7-7'}
          />
        </svg>
      </button>
      {isOpen && (
        <div className="absolute left-0 right-0 z-50 mt-1 bg-base border border-gilt-a rounded shadow-lg flex flex-col max-h-72">
          {searchable && (
            <div className="p-2 border-b border-gilt-b flex-shrink-0">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={searchPlaceholder}
                autoFocus
                className="g-field g-field-sm"
              />
            </div>
          )}
          <div className="overflow-y-auto">
            {items.length === 0 ? (
              <p className="px-3 py-2 text-sm text-subtext-0">{emptyMessage}</p>
            ) : visibleItems.length === 0 ? (
              <p className="px-3 py-2 text-sm text-subtext-0">No matches</p>
            ) : (
              visibleItems.map((item) => {
                const checked = selectedIds.includes(item.id);
                return (
                  <label
                    key={item.id}
                    className="flex items-center gap-2.5 px-3 min-h-[38px] border-b border-gilt-b last:border-b-0 hover:bg-gilt-b transition-colors cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(item.id)}
                      className="w-4 h-4 accent-[var(--color-gold)] flex-shrink-0"
                    />
                    <span className="text-sm text-text truncate">{getDisplayName(item)}</span>
                  </label>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
