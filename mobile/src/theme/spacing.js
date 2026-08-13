import { moderateScale } from '../utils/responsive';

// Consistent spacing scale used across every screen. Values are moderately
// scaled off the device's screen width so a tablet gets modestly larger
// spacing than a small phone instead of every screen assuming one fixed
// phone size.
export const spacing = {
  screenHorizontal: moderateScale(20),
  screenTop: moderateScale(20),
  screenBottom: moderateScale(20),
  cardGap: moderateScale(16),
  textGap: moderateScale(8),
  buttonMargin: moderateScale(24),

  xs: moderateScale(4),
  sm: moderateScale(8),
  md: moderateScale(12),
  lg: moderateScale(16),
  xl: moderateScale(20),
  xxl: moderateScale(24),
  xxxl: moderateScale(32),
};

export const radius = {
  card: moderateScale(20),
  button: moderateScale(14),
  input: moderateScale(14),
  pill: 999,
  sm: moderateScale(8),
  md: moderateScale(12),
};
