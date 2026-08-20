// Without this, React 18/19's act() doesn't recognize this as a test
// environment, so react-test-renderer's initial render never actually
// commits — TestRenderer.create(...).toJSON() silently returns null instead
// of the rendered tree, with no error, just an "update ... not wrapped in
// act(...)" warning. This is what was making every component-render test
// (not just this feature's) a silent no-op.
global.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

// Official mock — without it, any screen using useSafeAreaInsets() (most of
// them, via AppHeader) throws "No safe area value available" outside a real
// <SafeAreaProvider>.
jest.mock('react-native-safe-area-context', () => {
  // The package's own mock is authored as an ES `export default` compiled to
  // CJS — requiring it directly hands back `{ default: {...} }` instead of
  // the flat named exports (useSafeAreaInsets, SafeAreaProvider, ...) that
  // consumers actually import.
  const mock = require('react-native-safe-area-context/jest/mock');
  return mock.default || mock;
});

// react-native-maps is a native module with no meaningful jsdom/jest
// rendering — stand in with plain components so screens that import it
// (e.g. DealerNavigationScreen) can still be unit tested. forwardRef +
// useImperativeHandle exposes fitToCoordinates/animateToRegion as shared
// jest.fn()s (module-scoped, not per-instance, so a test can import and
// assert on the same mock DealerNavigationScreen's own ref actually called)
// — DealerNavigationScreen calls fitToCoordinates from onMapReady to work
// around Android's real initialRegion unreliability; a plain function
// component here would both warn ("function components cannot be given
// refs") and leave ref.current permanently null. Also fires onMapReady once
// after mount, same as the real native view eventually does, so that code
// path actually runs under test instead of silently never firing.
jest.mock('react-native-maps', () => {
  const React = require('react');
  const { View } = require('react-native');
  const fitToCoordinatesMock = jest.fn();
  const animateToRegionMock = jest.fn();
  const MapView = React.forwardRef((props, ref) => {
    React.useImperativeHandle(ref, () => ({ fitToCoordinates: fitToCoordinatesMock, animateToRegion: animateToRegionMock }));
    React.useEffect(() => { props.onMapReady?.(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
    return React.createElement(View, props, props.children);
  });
  MapView.Marker = (props) => React.createElement(View, props);
  MapView.Polyline = (props) => React.createElement(View, props);
  return {
    __esModule: true,
    default: MapView,
    Marker: MapView.Marker,
    Polyline: MapView.Polyline,
    PROVIDER_GOOGLE: 'google',
    __fitToCoordinatesMock: fitToCoordinatesMock,
    __animateToRegionMock: animateToRegionMock,
  };
});
