// Centralized color palette — do not hardcode hex values in screens/components.
// Single flat brand green used for buttons/icons/links.
export const GREEN = '#22C55E';

export const colors = {
  // Identity color for text/icons on light backgrounds.
  primary: GREEN,
  primaryMid: GREEN,
  primaryDark: GREEN,
  primaryLight: '#DCFCE7',
  primaryTint: '#F0FDF4',

  // Very light, airy green gradient for large fills — headers, the login
  // backdrop — kept pale so these big areas stay calm and easy on the eye
  // instead of a wall of saturated green. Buttons, icons, and links all
  // stay flat GREEN; this is only for large background areas.
  gradientHeader: ['#F0FDF4', '#BBF7D0'],

  // Button fills — same flat green for default and pressed.
  buttonBg: GREEN,
  buttonBgPressed: GREEN,
  buttonText: '#FFFFFF',

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

  text: '#1F2937',
  textSecondary: '#5C6B63',
  textMuted: '#6B7280',
  textInverse: '#FFFFFF',

  border: '#DDE9E1',
  borderStrong: '#C7D9CD',

  neutralBg: '#F3F4F6',
  neutralBorder: '#E5E7EB',

  avatarBg: '#DCFCE7',
  avatarText: GREEN,

  overlay: 'rgba(17, 24, 39, 0.45)',
  disabled: '#CBD5E1',
  disabledText: '#94A3B8',
};
