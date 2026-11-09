"""Scalar forecast entities."""

from time import time

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory, UnitOfEnergy, UnitOfPower
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .const import DOMAIN
from .history import utc
from .runtime import Project


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddConfigEntryEntitiesCallback
) -> None:
    project = hass.data[DOMAIN].projects[entry.entry_id]
    entities = [
        ForecastSensor(project, "next", "Next interval"),
        ForecastSensor(project, "status", "Status"),
    ]
    if project.settings["solar"]:
        entities.extend(
            (
                ForecastSensor(
                    project,
                    "today_remaining",
                    "Remaining solar production today",
                    UnitOfEnergy.WATT_HOUR,
                    SensorDeviceClass.ENERGY,
                ),
                ForecastSensor(
                    project,
                    "tomorrow",
                    "Solar production tomorrow",
                    UnitOfEnergy.WATT_HOUR,
                    SensorDeviceClass.ENERGY,
                ),
                ForecastSensor(
                    project,
                    "peak",
                    "Forecast peak power",
                    UnitOfPower.WATT,
                    SensorDeviceClass.POWER,
                ),
                ForecastSensor(
                    project, "peak_time", "Forecast peak time", None, SensorDeviceClass.TIMESTAMP
                ),
            )
        )
    async_add_entities(entities)


class ForecastSensor(SensorEntity):
    _attr_should_poll = False
    _attr_has_entity_name = True

    def __init__(self, project: Project, key: str, name: str, unit=None, device_class=None) -> None:
        self.project = project
        self.key = key
        self._attr_unique_id = f"{project.id}_{key}"
        self._attr_name = name
        self._attr_native_unit_of_measurement = unit
        self._attr_device_class = device_class
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, project.id)}, name=project.settings["name"]
        )
        if key == "status":
            self._attr_entity_category = EntityCategory.DIAGNOSTIC
            self._attr_icon = "mdi:chart-timeline-variant"
        elif device_class != SensorDeviceClass.TIMESTAMP:
            self._attr_suggested_display_precision = 2

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self.async_on_remove(self.project.listen(self.async_write_ha_state))

    @property
    def available(self) -> bool:
        return self.key == "status" or (self.project.usable and self.native_value is not None)

    @property
    def native_unit_of_measurement(self):
        if self.key == "next" and (result := self.project.current):
            return result["unit"] or None
        return self._attr_native_unit_of_measurement

    @property
    def native_value(self):
        if self.key == "status":
            return self.project.status
        if not self.project.usable:
            return None
        result = self.project.current
        if self.key == "next":
            now = time()
            return next(
                (
                    point["value"]
                    for point in result["points"]
                    if point["start"] + result["step_minutes"] * 60 > now
                ),
                None,
            )
        solar = self.project.solar_view(result)
        if self.key in ("peak", "peak_time"):
            peak = solar["peak"]
            if not peak:
                return None
            return peak["watts"] if self.key == "peak" else utc(peak["start"])
        total = solar[self.key]
        return total["wh"] if total["complete"] else None

    @property
    def extra_state_attributes(self):
        result = self.project.current
        attributes = {"forecast_status": self.project.status}
        if result:
            attributes.update(
                {
                    "model": result["model"],
                    "issued_at": utc(result["issued_at"]).isoformat(),
                    "interval_minutes": result["step_minutes"],
                    "forecast_until": utc(
                        result["points"][-1]["start"] + result["step_minutes"] * 60
                    ).isoformat(),
                }
            )
        if self.key == "status" and self.project.error:
            attributes["error"] = self.project.error
        return attributes
