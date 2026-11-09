"""Native Energy dashboard solar forecasts."""

from datetime import datetime
from time import time

from homeassistant.components.energy.types import SolarForecastType
from homeassistant.core import HomeAssistant

from .const import DOMAIN


async def async_get_solar_forecast(
    hass: HomeAssistant, config_entry_id: str
) -> SolarForecastType | None:
    state = hass.data.get(DOMAIN)
    project = state.projects.get(config_entry_id) if state else None
    if not project or not project.usable or not (solar := project.current.get("solar")):
        return None
    now = time()
    return {
        "wh_hours": {
            stamp: value
            for stamp, value in solar["wh_hours"].items()
            if datetime.fromisoformat(stamp).timestamp() + 3600 > now
        },
    }
