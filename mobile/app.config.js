// app.config.js — extends app.json (kept as the static base config) only to
// inject the Google Maps API keys that react-native-maps needs baked into
// the native AndroidManifest.xml/Info.plist at prebuild time.
//
// react-native-maps has NO Expo config plugin (no app.plugin.js) — it must
// NOT be listed in the `plugins` array (doing so crashes `expo config`/EAS
// builds trying to resolve it as one: "Unable to resolve a valid config
// plugin for react-native-maps"). The documented way to configure its
// Google Maps API keys under Expo is the dedicated
// android.config.googleMaps.apiKey / ios.config.googleMapsApiKey fields
// below, which react-native-maps' autolinking reads directly.
//
// app.json itself is plain JSON with no templating, so `$ENV_VAR`-style
// placeholders there are never substituted — they'd be written into the
// native project as literal, invalid strings. A `.js` config is required to
// actually read process.env at config-evaluation time (set via a local
// `.env` for `expo prebuild`/dev builds, or an `eas env:set`-registered
// variable for EAS Build).
module.exports = ({ config }) => ({
  ...config,
  android: {
    ...config.android,
    config: {
      ...config.android?.config,
      googleMaps: {
        apiKey: process.env.EXPO_PUBLIC_MAPS_ANDROID_API_KEY,
      },
    },
  },
  ios: {
    ...config.ios,
    config: {
      ...config.ios?.config,
      googleMapsApiKey: process.env.EXPO_PUBLIC_MAPS_IOS_API_KEY,
    },
  },
});
