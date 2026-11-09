"""Run with the target Home Assistant Core environment."""

from datetime import UTC, datetime
from unittest import TestCase

from homeassistant.core import State

from custom_components.local_forecast.history import Source, raw_buckets, stat_buckets
from custom_components.local_forecast.solar import current_solar

START = 1767225600


def state(offset, value, unit):
    stamp = datetime.fromtimestamp(START + offset, UTC)
    return State(
        "sensor.test",
        str(value),
        {"unit_of_measurement": unit},
        last_changed=stamp,
        last_updated=stamp,
    )


class RecorderNormalization(TestCase):
    def test_irregular_measurements_are_time_weighted_and_unknown_is_missing(self):
        source = Source("sensor.test", "W")
        result = raw_buckets(
            [
                state(-1, 100, "W"),
                state(300, 0.4, "kW"),
                state(1020, "unavailable", "W"),
                state(1800, 120, "W"),
            ],
            source,
            START,
            START + 2700,
            900,
        )
        self.assertEqual(result, [300.0, None, 120.0])

    def test_reset_and_unit_change_keep_interval_energy_increments(self):
        source = Source("sensor.test", "Wh", "increasing")
        result = raw_buckets(
            [
                state(-1, 1, "kWh"),
                state(120, 1.1, "kWh"),
                state(1000, 50, "Wh"),
                state(1200, 150, "Wh"),
            ],
            source,
            START,
            START + 1800,
            900,
        )
        self.assertEqual(result, [100.0, 150.0])

    def test_statistics_do_not_move_a_gap_into_the_next_bucket(self):
        source = Source("sensor.test", "Wh", "increasing")
        result = stat_buckets(
            [
                {"start": START - 3600, "sum": 1.0},
                {"start": START, "sum": 1.2, "change": 0.2},
                {"start": START + 7200, "sum": 1.6, "change": 0.4},
            ],
            source,
            "kWh",
            3600,
            START,
            START + 10800,
            3600,
        )
        self.assertEqual(result, [200.0, None, None])

    def test_cached_solar_forecast_recomputes_daily_totals_after_midnight(self):
        now = int(datetime(2026, 11, 8, 23, 30, tzinfo=UTC).timestamp())
        cutoff = now - 3600 - 1800
        forecast = {
            "unit": "W",
            "step_minutes": 60,
            "timezone": "Europe/Paris",
            "solar": {"wh_hours": {}},
            "points": [{"start": cutoff + index * 3600, "value": 100} for index in range(48)],
        }
        solar = current_solar(forecast, now)
        self.assertEqual(solar["today_remaining"], {"wh": 2350.0, "complete": True})
        self.assertEqual(solar["tomorrow"], {"wh": 2300.0, "complete": False})

    def test_local_tomorrow_has_25_hours_when_clocks_go_back(self):
        cutoff = int(datetime(2026, 10, 24, 14, tzinfo=UTC).timestamp())
        forecast = {
            "unit": "Wh",
            "step_minutes": 15,
            "timezone": "Europe/Paris",
            "solar": {"wh_hours": {}},
            "points": [{"start": cutoff + index * 900, "value": 100} for index in range(192)],
        }
        self.assertEqual(
            current_solar(forecast, cutoff)["tomorrow"], {"wh": 10000.0, "complete": True}
        )
