import { registerRootComponent } from 'expo';
import { Alert, Text, TextInput } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';
import { initCrashReporter, captureException } from './src/services/crashReporter';

// Before anything else runs — including the ErrorUtils handler just below —
// so even a startup-time crash is reported, not just crashes that happen
// once the app is fully up. No-ops safely if EXPO_PUBLIC_SENTRY_DSN isn't
// configured (see crashReporter.js).
initCrashReporter();

// The OS-level "font size" / "display size" accessibility setting differs
// per device and is a common reason the same screen renders with visibly
// different text/layout proportions on two different phones. Pinning
// allowFontScaling off (once, globally, before any component renders)
// makes text size consistent across devices regardless of that setting.
Text.defaultProps = Text.defaultProps || {};
Text.defaultProps.allowFontScaling = false;
TextInput.defaultProps = TextInput.defaultProps || {};
TextInput.defaultProps.allowFontScaling = false;

// TEMPORARY diagnostic: production (release) builds normally crash silently
// on an unhandled JS exception with no on-screen trace, which is why the app
// was force-quitting with no way to tell what broke. Surfacing it via the
// native Alert (not the themed one — that depends on React having already
// rendered, which a startup-time crash may never reach) turns the very next
// crash into a screenshot-able error message instead of a silent close.
// Remove once the root cause is found and fixed.
const defaultGlobalHandler = global.ErrorUtils.getGlobalHandler();
global.ErrorUtils.setGlobalHandler((error, isFatal) => {
  captureException(error, { area: 'global-handler', isFatal });
  Alert.alert(
    isFatal ? 'Fatal error' : 'Error',
    `${error?.name || 'Error'}: ${error?.message || String(error)}\n\n${error?.stack || ''}`.slice(0, 1800)
  );
  defaultGlobalHandler(error, isFatal);
});

// Deliberately require() rather than import here: Babel hoists `import`
// declarations above plain statements (including the ErrorUtils handler set
// up just above), so an `import` of this — or of App below, which pulls in
// the same transitive dependencies — would run before that handler exists,
// letting a startup-time throw (e.g. a missing required env var) bypass the
// diagnostic entirely. require() is an ordinary function call and isn't
// hoisted, so it runs where it's written: after the handler is installed.
//
// Must still happen before the root component registers, so
// expo-task-manager's defineTask() call runs even when the OS headlessly
// relaunches the JS context to deliver a background geofence event (the rep
// never opened the app for this launch).
require('./src/services/geofenceTask');

const App = require('./App').default;

// The native splash (configured in app.json to match SplashScreen.js's look)
// stays up until the JS splash screen has mounted and taken over, so the two
// read as one continuous splash instead of a visible hand-off between them.
SplashScreen.preventAutoHideAsync();

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
