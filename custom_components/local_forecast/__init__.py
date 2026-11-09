"""Local Forecast integration."""

from pathlib import Path

from homeassistant.components.http import StaticPathConfig
from homeassistant.components.panel_custom import async_register_panel
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from . import commands
from .client import Engine
from .const import DOMAIN, PANEL, VERSION
from .runtime import DomainData, Project

PLATFORMS = [Platform.SENSOR]
CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)


async def async_setup(hass: HomeAssistant, _config: dict) -> bool:
    hass.data[DOMAIN] = DomainData()
    await hass.http.async_register_static_paths(
        [
            StaticPathConfig(
                "/local_forecast_static", str(Path(__file__).parent / "frontend"), False
            ),
        ]
    )
    await async_register_panel(
        hass,
        PANEL,
        "local-forecast-lab",
        sidebar_title="Forecast Lab",
        sidebar_icon="mdi:chart-timeline-variant",
        module_url=f"/local_forecast_static/forecast-lab.js?v={VERSION}",
        require_admin=True,
    )
    commands.async_register(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    state: DomainData = hass.data[DOMAIN]
    if entry.data["kind"] == "engine":
        state.engines[entry.entry_id] = Engine(
            async_get_clientsession(hass),
            entry.data["url"],
            entry.data["token"],
        )
        return True
    project = Project(hass, entry, state)
    state.projects[entry.entry_id] = project
    try:
        await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    except Exception:
        state.projects.pop(entry.entry_id, None)
        raise
    project.start()
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    state: DomainData = hass.data[DOMAIN]
    if entry.data["kind"] == "engine":
        state.engines.pop(entry.entry_id, None)
        return True
    if not await hass.config_entries.async_unload_platforms(entry, PLATFORMS):
        return False
    if project := state.projects.pop(entry.entry_id, None):
        await project.stop()
    return True
