import { registerRootComponent } from 'expo';
import { Text, TextInput } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';
import { initCrashReporter, captureException } from './src/services/crashReporter';

// Before anything else runs — including the ErrorUtils handler just below —
// so even a startup-time crash is caught, not just crashes that happen once
// the app is fully up. Local-only (see crashReporter.js) — no external
// crash-reporting service is wired in.
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

// Global JS exception handler — logs every uncaught error locally (see
// crashReporter.js — no external reporting service is wired in) before
// falling through to React Native's default handling (which shows the dev
// red-box in development, or crashes/restarts in production). This used to
// also surface a raw native Alert with the stack trace as a stopgap while
// the app's root cause of unexplained restarts (an OS-level MIUI background
// kill, not a JS crash — see visitForegroundService.js/miui.js) was still
// unidentified. That's since been root-caused and mitigated, so the
// diagnostic Alert was removed: it was surfacing raw stack traces to real
// production users on every crash instead of just logging quietly.
const defaultGlobalHandler = global.ErrorUtils.getGlobalHandler();
global.ErrorUtils.setGlobalHandler((error, isFatal) => {
  captureException(error, { area: 'global-handler', isFatal });
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
