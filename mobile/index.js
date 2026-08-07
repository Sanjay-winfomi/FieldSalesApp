import { registerRootComponent } from 'expo';
import * as SplashScreen from 'expo-splash-screen';

// Must be imported unconditionally at startup, before the root component
// registers, so expo-task-manager's defineTask() call runs even when the OS
// headlessly relaunches the JS context to deliver a background geofence
// event (the rep never opened the app for this launch).
import './src/services/geofenceTask';

import App from './App';

// The native splash (configured in app.json to match SplashScreen.js's look)
// stays up until the JS splash screen has mounted and taken over, so the two
// read as one continuous splash instead of a visible hand-off between them.
SplashScreen.preventAutoHideAsync();

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
