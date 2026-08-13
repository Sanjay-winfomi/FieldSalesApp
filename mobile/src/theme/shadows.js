import { Platform } from 'react-native';

// A single soft "card" elevation used everywhere, expressed for both engines.
export const shadows = {
  card: Platform.select({
    ios: {
      shadowColor: '#0F172A',
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.10,
      shadowRadius: 16,
    },
    android: { elevation: 4 },
    default: {},
  }),
  raised: Platform.select({
    ios: {
      shadowColor: '#0F172A',
      shadowOffset: { width: 0, height: 10 },
      shadowOpacity: 0.16,
      shadowRadius: 24,
    },
    android: { elevation: 8 },
    default: {},
  }),
  buttonPrimary: Platform.select({
    ios: {
      shadowColor: '#22C55E',
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.35,
      shadowRadius: 14,
    },
    android: { elevation: 5 },
    default: {},
  }),
};
