// Centralized color palette — do not hardcode hex values in pages/components.
// Single flat brand green used everywhere for FILLS (buttons, banners, badge
// backgrounds). Text/icon/border usage of "brand green" uses a darker shade
// (primary, below) instead — GREEN itself is ~2.3:1 contrast against white,
// well under WCAG AA's 4.5:1 for text and 3:1 for UI components/large text,
// which was a real legibility problem for nav links, badge text, and avatar
// initials when they used GREEN directly.
export const GREEN = '#22C55E';

export const colors = {
  // Identity color for text/icons/links/borders on light backgrounds —
  // #15803D (~4.6:1 on white) instead of the flat GREEN fill color above.
  primary: '#15803D',
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

  info: '#15803D',
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
  avatarText: '#15803D',

  overlay: 'rgba(15, 23, 42, 0.5)',
  disabled: '#CBD5E1',
  disabledText: '#94A3B8',
};
