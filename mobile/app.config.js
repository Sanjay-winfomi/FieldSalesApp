// app.config.js — extends app.json (kept as the static base config) only to
// inject the Google Maps API keys, which react-native-maps' config plugin
// needs baked into the native AndroidManifest.xml/Info.plist at prebuild
// time. app.json is plain JSON with no templating, so `$ENV_VAR`-style
// placeholders there are never substituted — they'd be written into the
// native project as literal, invalid strings. A `.js` config is required to
// actually read process.env at config-evaluation time (set via a local
// `.env`/shell export for `expo prebuild`/dev builds, or eas.json's
// build.<profile>.env for EAS Build).
module.exports = ({ config }) => ({
  ...config,
  plugins: config.plugins.map((plugin) =>
    plugin === 'react-native-maps'
      ? [
          'react-native-maps',
          {
            androidGoogleMapsApiKey: process.env.EXPO_PUBLIC_MAPS_ANDROID_API_KEY,
            iosGoogleMapsApiKey: process.env.EXPO_PUBLIC_MAPS_IOS_API_KEY,
          },
        ]
      : plugin
  ),
});
