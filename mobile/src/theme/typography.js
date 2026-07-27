import { Platform } from 'react-native';

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

export const typography = {
  pageTitle: { fontFamily, fontSize: 30, fontWeight: '700' },
  sectionTitle: { fontFamily, fontSize: 22, fontWeight: '700' },
  cardTitle: { fontFamily: fontFamilyMedium, fontSize: 18, fontWeight: '600' },
  body: { fontFamily, fontSize: 15, fontWeight: '400' },
  bodyMedium: { fontFamily: fontFamilyMedium, fontSize: 15, fontWeight: '600' },
  caption: { fontFamily, fontSize: 13, fontWeight: '400' },
  button: { fontFamily: fontFamilyMedium, fontSize: 16, fontWeight: '600' },
};
