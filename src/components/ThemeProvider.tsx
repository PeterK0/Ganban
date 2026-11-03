import { useEffect } from 'react';
import { useAppStore } from '../store/appStore';
import { themes } from '../themes';

interface ThemeProviderProps {
  children: React.ReactNode;
}

export default function ThemeProvider({ children }: ThemeProviderProps) {
  const { currentTheme } = useAppStore();

  useEffect(() => {
    const theme = themes[currentTheme];
    if (!theme) return;

    const root = document.documentElement;
    // A hook for the few theme-specific CSS rules (gilt.css: Latte's darker warning text).
    root.dataset.theme = currentTheme;

    // Apply theme colors as CSS variables
    root.style.setProperty('--color-crust', theme.colors.crust);
    root.style.setProperty('--color-mantle', theme.colors.mantle);
    root.style.setProperty('--color-base', theme.colors.base);
    root.style.setProperty('--color-surface-0', theme.colors.surface0);
    root.style.setProperty('--color-surface-1', theme.colors.surface1);
    root.style.setProperty('--color-surface-2', theme.colors.surface2);
    root.style.setProperty('--color-overlay-0', theme.colors.overlay0);
    root.style.setProperty('--color-overlay-1', theme.colors.overlay1);
    root.style.setProperty('--color-overlay-2', theme.colors.overlay2);
    root.style.setProperty('--color-text', theme.colors.text);
    root.style.setProperty('--color-subtext-0', theme.colors.subtext0);
    root.style.setProperty('--color-subtext-1', theme.colors.subtext1);
    root.style.setProperty('--color-primary-text', theme.colors.primaryText);
    root.style.setProperty('--color-gold', theme.colors.gold);
    root.style.setProperty('--color-gilt-a', theme.colors.giltA);
    root.style.setProperty('--color-gilt-b', theme.colors.giltB);
    root.style.setProperty('--color-primary', theme.colors.primary);
    root.style.setProperty('--color-primary-hover', theme.colors.primaryHover);
    root.style.setProperty('--color-secondary', theme.colors.secondary);
    root.style.setProperty('--color-success', theme.colors.success);
    root.style.setProperty('--color-warning', theme.colors.warning);
    root.style.setProperty('--color-error', theme.colors.error);
    root.style.setProperty('--color-info', theme.colors.info);
    root.style.setProperty('--color-low', theme.colors.low);
    root.style.setProperty('--color-medium', theme.colors.medium);
    root.style.setProperty('--color-high', theme.colors.high);
  }, [currentTheme]);

  return <>{children}</>;
}
