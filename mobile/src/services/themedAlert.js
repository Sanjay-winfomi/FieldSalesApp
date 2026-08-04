/**
 * themedAlert.js — drop-in replacement for React Native's Alert.alert.
 *
 * Alert.alert always renders the OS's native system dialog (iOS
 * UIAlertController / Android AlertDialog) — it ignores app styling
 * entirely, so it can never match the app's theme/colors. This module keeps
 * the exact same call signature (title, message, buttons) but routes the
 * request to <ThemedAlertHost/> (mounted once in App.js), which renders a
 * themed in-app Modal instead.
 */
let _handler = null;

export function registerAlertHandler(handler) {
  _handler = handler;
}

export function showAlert(title, message, buttons) {
  if (!_handler) {
    console.warn('showAlert called before ThemedAlertHost mounted — dropping alert:', title);
    return;
  }
  _handler(title, message, buttons);
}
