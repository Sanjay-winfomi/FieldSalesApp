import * as Location from 'expo-location';

/**
 * Request foreground permissions and fetch the current GPS location.
 * @returns {Promise<{lat: number, lng: number} | null>}
 */
export const getCurrentLocation = async () => {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    
    if (status !== 'granted') {
      console.warn('Permission to access location was denied');
      return null;
    }

    const location = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });
    
    return {
      lat: location.coords.latitude,
      lng: location.coords.longitude,
    };
  } catch (error) {
    console.error('Error fetching location:', error);
    return null;
  }
};

/**
 * Perform reverse geocoding to turn coordinates into a human-readable address.
 * @param {number} lat
 * @param {number} lng
 * @returns {Promise<string>}
 */
export const getReadableAddress = async (lat, lng) => {
  try {
    const response = await Location.reverseGeocodeAsync({
      latitude: lat,
      longitude: lng,
    });

    if (response && response.length > 0) {
      const { name, street, city, region, postalCode } = response[0];
      const addressParts = [];
      
      if (name || street) addressParts.push(name || street);
      if (city) addressParts.push(city);
      if (region) addressParts.push(region);
      if (postalCode) addressParts.push(postalCode);

      return addressParts.join(', ');
    }
    return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  } catch (error) {
    console.error('Error geocoding address:', error);
    return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  }
};
