"""Integration constants."""

DOMAIN = "local_forecast"
PANEL = "forecast-lab"
VERSION = "0.1.0"
BASELINES = ("persistence", "previous-day", "previous-week")
MODELS = (
    *BASELINES,
    "timestral-5m",
    "timestral-28m",
    "timestral-123m",
    "timestral-209m",
    "chronos-2",
)
WEATHER_FIELDS = (
    "temperature",
    "cloud_coverage",
    "humidity",
    "precipitation",
    "precipitation_probability",
    "wind_speed",
    "pressure",
    "uv_index",
)
DEFAULT_PROJECT = {
    "name": "",
    "target": "",
    "model": "timestral-5m",
    "step_minutes": 60,
    "horizon_hours": 48,
    "history_days": 28,
    "refresh_minutes": 60,
    "mode": "auto",
    "solar": False,
    "enabled": False,
    "inputs": [],
}
