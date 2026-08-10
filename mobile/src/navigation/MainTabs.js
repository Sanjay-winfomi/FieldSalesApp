import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Home, User } from 'lucide-react-native';
import { colors } from '../theme';

import HomeScreen from '../../screens/HomeScreen';
import ProfileScreen from '../../screens/ProfileScreen';

const Tab = createBottomTabNavigator();

/**
 * The main app shell — a real bottom tab navigator (previously Home/Dealers/
 * History/Profile were just local state inside HomeScreen with a hand-rolled
 * tab bar). Respects the device safe area so the bar never sits under a
 * gesture-nav home indicator, and gives each tab a proper touch target.
 *
 * Dealers and History used to be tabs here — now that dealer visits are
 * manager-assigned (see "Today's Assigned Dealers"/TodaysVisitsScreen) and
 * history is reached by drilling into Home's summary tiles instead, both
 * moved to plain Stack screens in App.js rather than living in this tab bar.
 */
export default function MainTabs() {
  const insets = useSafeAreaInsets();
  // Extra buffer on top of the device's own safe-area inset — on several
  // Android devices/builds the reported gesture-nav inset alone still isn't
  // quite enough clearance and the labels end up sitting under the system
  // nav bar, so this pads it further rather than trusting insets.bottom
  // exactly.
  const bottomPad = insets.bottom + 16;

  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: {
          height: 58 + bottomPad,
          paddingBottom: bottomPad,
          paddingTop: 8,
          backgroundColor: colors.card,
          borderTopColor: colors.border,
          borderTopWidth: 1,
        },
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '600',
          marginTop: 2,
        },
        tabBarItemStyle: {
          paddingVertical: 2,
        },
        tabBarHideOnKeyboard: true,
      }}
    >
      <Tab.Screen
        name="Home"
        component={HomeScreen}
        options={{
          tabBarIcon: ({ color, size }) => <Home size={size ?? 22} color={color} />,
          tabBarAccessibilityLabel: 'Home tab',
        }}
      />
      <Tab.Screen
        name="Profile"
        component={ProfileScreen}
        options={{
          tabBarIcon: ({ color, size }) => <User size={size ?? 22} color={color} />,
          tabBarAccessibilityLabel: 'Profile tab',
        }}
      />
    </Tab.Navigator>
  );
}
