"""Ported from backend/tests/haversine.test.js — same test pairs/tolerances,
same source of the "known distance" reference values."""
from app.utils.haversine import haversine_km, is_within_radius


class TestHaversineKm:
    def test_same_point_returns_0(self):
        assert haversine_km(11.0168, 76.9558, 11.0168, 76.9558) == 0

    def test_about_1km_apart(self):
        dist = haversine_km(11.0168, 76.9558, 11.0258, 76.9558)
        assert 0.95 < dist < 1.05

    def test_about_5km_apart(self):
        dist = haversine_km(11.0098, 76.9558, 11.0234, 77.0012)
        assert 4.0 < dist < 6.0

    def test_about_10_to_13km_apart(self):
        dist = haversine_km(11.0000, 76.9500, 11.0900, 77.0200)
        assert 10.0 < dist < 14.0

    def test_known_distance_london_to_paris(self):
        dist = haversine_km(51.5074, -0.1278, 48.8566, 2.3522)
        assert 335 < dist < 347

    def test_known_distance_nyc_to_la(self):
        dist = haversine_km(40.7128, -74.006, 34.0522, -118.2437)
        assert 3900 < dist < 4000


class TestIsWithinRadius:
    def test_inside_radius(self):
        assert is_within_radius(11.0168, 76.9558, 11.01685, 76.9559, 100) is True

    def test_outside_radius(self):
        assert is_within_radius(11.0168, 76.9558, 11.0258, 76.9558, 100) is False

    def test_exact_boundary_just_inside(self):
        assert is_within_radius(11.0, 77.0, 11.000891, 77.0, 100) is True
