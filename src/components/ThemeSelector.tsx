import { useState } from 'react';
import { useAppStore } from '../store/appStore';
import { themes } from '../themes';

export default function ThemeSelector() {
  const { currentTheme, setTheme } = useAppStore();
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="p-2 rounded-lg hover:bg-surface-1 transition-colors"
        title="Change theme"
      >
        <svg
          className="w-5 h-5"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01"
          />
        </svg>
      </button>

      {isOpen && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-10"
            onClick={() => setIsOpen(false)}
          />

          {/* Dropdown */}
          <div className="absolute right-0 mt-2 w-64 bg-surface-0 rounded-lg shadow-xl border border-surface-2 z-20 overflow-hidden">
            <div className="p-3 border-b border-surface-2">
              <h3 className="text-sm font-semibold text-text">Select Theme</h3>
            </div>
            <div className="max-h-96 overflow-y-auto">
              {Object.entries(themes).map(([key, theme]) => (
                <button
                  key={key}
                  onClick={() => {
                    setTheme(key);
                    setIsOpen(false);
                  }}
                  className={`w-full px-4 py-3 text-left hover:bg-surface-1 transition-colors ${
                    currentTheme === key ? 'bg-surface-1' : ''
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <div className="text-sm font-medium text-text">
                        {theme.name}
                      </div>
                      <div className="flex gap-1 mt-2">
                        <div
                          className="w-4 h-4 rounded"
                          style={{ backgroundColor: theme.colors.primary }}
                        />
                        <div
                          className="w-4 h-4 rounded"
                          style={{ backgroundColor: theme.colors.secondary }}
                        />
                        <div
                          className="w-4 h-4 rounded"
                          style={{ backgroundColor: theme.colors.success }}
                        />
                        <div
                          className="w-4 h-4 rounded"
                          style={{ backgroundColor: theme.colors.warning }}
                        />
                        <div
                          className="w-4 h-4 rounded"
                          style={{ backgroundColor: theme.colors.error }}
                        />
                      </div>
                    </div>
                    {currentTheme === key && (
                      <svg
                        className="w-5 h-5 text-primary"
                        fill="currentColor"
                        viewBox="0 0 20 20"
                      >
                        <path
                          fillRule="evenodd"
                          d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                          clipRule="evenodd"
                        />
                      </svg>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
