export interface Theme {
  name: string;
  colors: {
    // Base colors
    crust: string; // Gilt: the darkest layer (top bar, sidebar)
    mantle: string; // Gilt: the app background
    base: string;
    surface0: string;
    surface1: string;
    surface2: string;
    overlay0: string;
    overlay1: string;
    overlay2: string;

    // Text colors
    text: string;
    subtext0: string;
    subtext1: string;
    primaryText: string; // Text color for primary buttons

    // Gilt ornaments: gold, and gold at ~30% (card borders) and ~11% (inner outlines, hover fills)
    gold: string;
    giltA: string;
    giltB: string;

    // Accent colors (in Gilt, primary is the theme's accent: Catppuccin mauve, Dracula purple)
    primary: string;
    primaryHover: string;
    secondary: string;

    // Status colors
    success: string;
    warning: string;
    error: string;
    info: string;

    // Priority colors
    low: string;
    medium: string;
    high: string;
  };
}

export const themes: Record<string, Theme> = {
  'catppuccin-mocha': {
    name: 'Catppuccin Mocha',
    colors: {
      crust: '#11111b',
      mantle: '#181825',
      base: '#1e1e2e',
      surface0: '#313244',
      surface1: '#45475a',
      surface2: '#585b70',
      overlay0: '#6c7086',
      overlay1: '#7f849c',
      overlay2: '#9399b2',
      text: '#e0def4',
      subtext0: '#bac2de',
      subtext1: '#cdd6f4',
      primaryText: '#1e1e2e',
      gold: '#f9e2af',
      giltA: 'rgba(249, 226, 175, 0.30)',
      giltB: 'rgba(249, 226, 175, 0.11)',
      primary: '#cba6f7',
      primaryHover: '#d7bbfa',
      secondary: '#f5c2e7',
      success: '#a6e3a1',
      warning: '#f9e2af',
      error: '#f38ba8',
      info: '#89dceb',
      low: '#89dceb',
      medium: '#f9e2af',
      high: '#f38ba8',
    },
  },
  'catppuccin-macchiato': {
    name: 'Catppuccin Macchiato',
    colors: {
      crust: '#181926',
      mantle: '#1e2030',
      base: '#24273a',
      surface0: '#363a4f',
      surface1: '#494d64',
      surface2: '#5b6078',
      overlay0: '#6e738d',
      overlay1: '#8087a2',
      overlay2: '#939ab7',
      text: '#cad3f5',
      subtext0: '#a5adcb',
      subtext1: '#b8c0e0',
      primaryText: '#24273a',
      gold: '#eed49f',
      giltA: 'rgba(238, 212, 159, 0.30)',
      giltB: 'rgba(238, 212, 159, 0.11)',
      primary: '#c6a0f6',
      primaryHover: '#d3b6f8',
      secondary: '#f5bde6',
      success: '#a6da95',
      warning: '#eed49f',
      error: '#ed8796',
      info: '#8bd5ca',
      low: '#8bd5ca',
      medium: '#eed49f',
      high: '#ed8796',
    },
  },
  'catppuccin-frappe': {
    name: 'Catppuccin Frappé',
    colors: {
      crust: '#232634',
      mantle: '#292c3c',
      base: '#303446',
      surface0: '#414559',
      surface1: '#51576d',
      surface2: '#626880',
      overlay0: '#737994',
      overlay1: '#838ba7',
      overlay2: '#949cbb',
      text: '#c6d0f5',
      subtext0: '#a5adce',
      subtext1: '#b5bfe2',
      primaryText: '#303446',
      gold: '#e5c890',
      giltA: 'rgba(229, 200, 144, 0.30)',
      giltB: 'rgba(229, 200, 144, 0.11)',
      primary: '#ca9ee6',
      primaryHover: '#d6b4ec',
      secondary: '#f4b8e4',
      success: '#a6d189',
      warning: '#e5c890',
      error: '#e78284',
      info: '#81c8be',
      low: '#81c8be',
      medium: '#e5c890',
      high: '#e78284',
    },
  },
  'catppuccin-latte': {
    name: 'Catppuccin Latte',
    colors: {
      crust: '#dce0e8',
      mantle: '#e6e9ef',
      base: '#eff1f5',
      surface0: '#ccd0da',
      surface1: '#bcc0cc',
      surface2: '#acb0be',
      overlay0: '#9ca0b0',
      overlay1: '#8c8fa1',
      overlay2: '#7c7f93',
      text: '#4c4f69',
      subtext0: '#6c6f85',
      subtext1: '#5c5f77',
      primaryText: '#eff1f5',
      gold: '#7e5a10',
      giltA: 'rgba(126, 90, 16, 0.30)',
      giltB: 'rgba(126, 90, 16, 0.11)',
      primary: '#8839ef',
      primaryHover: '#7a2fdc',
      secondary: '#ea76cb',
      success: '#40a02b',
      warning: '#df8e1d',
      error: '#d20f39',
      info: '#179299',
      low: '#179299',
      medium: '#df8e1d',
      high: '#d20f39',
    },
  },
  'dracula': {
    name: 'Dracula',
    colors: {
      crust: '#191a21',
      mantle: '#1e1f29',
      base: '#282a36',
      surface0: '#343746',
      surface1: '#44475a',
      surface2: '#6272a4',
      overlay0: '#6272a4',
      overlay1: '#7282b4',
      overlay2: '#8292c4',
      text: '#f8f8f2',
      subtext0: '#d0d0d0',
      subtext1: '#e0e0e0',
      primaryText: '#191a21',
      gold: '#ffcb8e',
      giltA: 'rgba(255, 184, 108, 0.34)',
      giltB: 'rgba(255, 184, 108, 0.12)',
      primary: '#bd93f9',
      primaryHover: '#cba9fb',
      secondary: '#ff79c6',
      success: '#50fa7b',
      warning: '#f1fa8c',
      error: '#ff5555',
      info: '#8be9fd',
      low: '#8be9fd',
      medium: '#f1fa8c',
      high: '#ff5555',
    },
  },
  'nord': {
    name: 'Nord',
    colors: {
      crust: '#242933',
      mantle: '#292e39',
      base: '#2e3440',
      surface0: '#3b4252',
      surface1: '#434c5e',
      surface2: '#4c566a',
      overlay0: '#4c566a',
      overlay1: '#5e81ac',
      overlay2: '#81a1c1',
      text: '#f5f7fa',
      subtext0: '#e5e9f0',
      subtext1: '#eceff4',
      primaryText: '#242933',
      gold: '#ebcb8b',
      giltA: 'rgba(235, 203, 139, 0.30)',
      giltB: 'rgba(235, 203, 139, 0.11)',
      primary: '#b48ead',
      primaryHover: '#c5a8c0',
      secondary: '#5e81ac', // the old primary, so it stays distinct from the accent
      success: '#a3be8c',
      warning: '#ebcb8b',
      error: '#bf616a',
      info: '#88c0d0',
      low: '#88c0d0',
      medium: '#ebcb8b',
      high: '#bf616a',
    },
  },
  'tokyo-night': {
    name: 'Tokyo Night',
    colors: {
      crust: '#111118',
      mantle: '#16161e',
      base: '#1a1b26',
      surface0: '#24283b',
      surface1: '#414868',
      surface2: '#565f89',
      overlay0: '#565f89',
      overlay1: '#7aa2f7',
      overlay2: '#7dcfff',
      text: '#c0caf5',
      subtext0: '#a9b1d6',
      subtext1: '#9aa5ce',
      primaryText: '#1a1b26',
      gold: '#e0af68',
      giltA: 'rgba(224, 175, 104, 0.30)',
      giltB: 'rgba(224, 175, 104, 0.11)',
      primary: '#bb9af7',
      primaryHover: '#cbb1f9',
      secondary: '#7aa2f7', // the old primary, so it stays distinct from the accent
      success: '#9ece6a',
      warning: '#e0af68',
      error: '#f7768e',
      info: '#7dcfff',
      low: '#7dcfff',
      medium: '#e0af68',
      high: '#f7768e',
    },
  },
  'gruvbox': {
    name: 'Gruvbox',
    colors: {
      crust: '#161819',
      mantle: '#1d2021',
      base: '#282828',
      surface0: '#3c3836',
      surface1: '#504945',
      surface2: '#665c54',
      overlay0: '#7c6f64',
      overlay1: '#928374',
      overlay2: '#a89984',
      text: '#ebdbb2',
      subtext0: '#d5c4a1',
      subtext1: '#bdae93',
      primaryText: '#282828',
      gold: '#fabd2f',
      giltA: 'rgba(250, 189, 47, 0.30)',
      giltB: 'rgba(250, 189, 47, 0.11)',
      primary: '#d3869b',
      primaryHover: '#dda2b2',
      secondary: '#83a598', // the old primary, so it stays distinct from the accent
      success: '#b8bb26',
      warning: '#fabd2f',
      error: '#fb4934',
      info: '#8ec07c',
      low: '#8ec07c',
      medium: '#fabd2f',
      high: '#fb4934',
    },
  },
};

export const defaultTheme = 'catppuccin-mocha';
