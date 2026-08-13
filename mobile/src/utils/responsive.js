import { Dimensions } from 'react-native';

const { width, height } = Dimensions.get('window');

// Design baseline: a typical ~390pt-wide phone (iPhone 12/13/14, most
// mid-range Android phones) — the size every screen's spacing/typography
// was originally tuned for. Scaling off this baseline keeps normal phones
// visually unchanged while growing sizes on tablet-width screens and
// shrinking them slightly on very small phones (e.g. iPhone SE).
const BASE_WIDTH = 390;
const BASE_HEIGHT = 844;

export const scale = (size) => (width / BASE_WIDTH) * size;
export const verticalScale = (size) => (height / BASE_HEIGHT) * size;

// `factor` dampens the scale so text/spacing doesn't grow linearly with
// screen width — a tablet twice as wide as the baseline shouldn't get 2x
// the padding/font size, just a modest increase.
export const moderateScale = (size, factor = 0.3) => size + (scale(size) - size) * factor;
