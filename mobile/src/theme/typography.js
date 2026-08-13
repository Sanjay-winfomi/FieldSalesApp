import { Platform } from 'react-native';
import { moderateScale } from '../utils/responsive';

// System font stack — avoids bundling/loading a custom font family while
// still matching the "Inter / SF Pro / System" spec on each platform.
export const fontFamily = Platform.select({
  ios: 'System',
  android: 'sans-serif',
  default: 'System',
});

export const fontFamilyMedium = Platform.select({
  ios: 'System',
  android: 'sans-serif-medium',
  default: 'System',
});

// Times New Roman for notepad-style entry — Android has no bundled "Times New
// Roman" font, but its default serif face renders visually equivalent.
export const serifFontFamily = Platform.select({
  ios: 'Times New Roman',
  android: 'serif',
  default: 'Times New Roman',
});

// Font sizes are moderately scaled off screen width (see utils/responsive.js)
// so text reads at a sensible size on both a small phone and a tablet,
// independent of the OS accessibility font-scale setting (disabled globally
// in index.js).
export const typography = {
  pageTitle: { fontFamily, fontSize: moderateScale(30), fontWeight: '700' },
  sectionTitle: { fontFamily, fontSize: moderateScale(22), fontWeight: '700' },
  cardTitle: { fontFamily: fontFamilyMedium, fontSize: moderateScale(18), fontWeight: '600' },
  body: { fontFamily, fontSize: moderateScale(15), fontWeight: '400' },
  bodyMedium: { fontFamily: fontFamilyMedium, fontSize: moderateScale(15), fontWeight: '600' },
  caption: { fontFamily, fontSize: moderateScale(13), fontWeight: '400' },
  button: { fontFamily: fontFamilyMedium, fontSize: moderateScale(16), fontWeight: '600' },
};
