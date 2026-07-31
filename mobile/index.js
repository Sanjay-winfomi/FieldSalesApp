import { registerRootComponent } from 'expo';

// Must be imported unconditionally at startup, before the root component
// registers, so expo-task-manager's defineTask() call runs even when the OS
// headlessly relaunches the JS context to deliver a background geofence
// event (the rep never opened the app for this launch).
import './src/services/geofenceTask';

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
