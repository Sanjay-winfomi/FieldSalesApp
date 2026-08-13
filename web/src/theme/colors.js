// Centralized color palette — do not hardcode hex values in pages/components.
// Single flat brand green used everywhere (buttons, links, icons, banners).
export const GREEN = '#22C55E';

export const colors = {
  // Identity color for text/icons/links/borders on light backgrounds.
  primary: GREEN,
  primaryMid: GREEN,
  primaryDark: GREEN,
  primaryLight: '#DCFCE7',
  primaryTint: '#F0FDF4',

  // Button fills — same flat green for default and hover.
  buttonBg: GREEN,
  buttonBgHover: GREEN,
  buttonText: '#FFFFFF',

  gradientPrimary: GREEN,
  gradientHero: GREEN,

  secondary: '#5C6B63',

  success: GREEN,
  successLight: '#F0FDF4',
  successDark: '#15803D',

  warning: '#F59E0B',
  warningLight: '#FFFBEB',
  warningDark: '#B45309',

  danger: '#EF4444',
  dangerLight: '#FEF2F2',
  dangerDark: '#B91C1C',

  info: GREEN,
  infoLight: '#F0FDF4',

  background: '#F5FBF6',
  card: '#FFFFFF',
  sidebar: '#FFFFFF',

  text: '#1F2937',
  textSecondary: '#5C6B63',
  textMuted: '#6B7280',
  textInverse: '#FFFFFF',

  border: '#DDE9E1',
  borderStrong: '#C7D9CD',
  hover: '#F4FBF7',

  neutralBg: '#F3F4F6',
  neutralBorder: '#E5E7EB',

  avatarBg: '#DCFCE7',
  avatarText: GREEN,

  overlay: 'rgba(15, 23, 42, 0.5)',
  disabled: '#CBD5E1',
  disabledText: '#94A3B8',
};
