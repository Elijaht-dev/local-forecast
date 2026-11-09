"""Pair a local engine and create HA entries for saved projects."""

import probatio as vol
from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.helpers import selector
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.service_info.hassio import HassioServiceInfo

from .client import Engine, EngineError, normalize_url
from .const import DOMAIN
from .project import validate_project

TOKEN = selector.TextSelector(selector.TextSelectorConfig(type=selector.TextSelectorType.PASSWORD))


class LocalForecastConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    def __init__(self) -> None:
        self.discovered: dict | None = None

    async def connect(self, data: dict) -> dict:
        url = normalize_url(data["url"])
        token = data["token"].strip()
        if (
            len(token) < 24
            or not token.isascii()
            or any(character.isspace() for character in token)
        ):
            raise EngineError("The engine token is invalid", 401)
        info = await Engine(async_get_clientsession(self.hass), url, token).health()
        return {"kind": "engine", "url": url, "token": token, "engine_id": info["id"]}

    async def async_step_user(self, user_input: dict | None = None) -> ConfigFlowResult:
        return await self.engine_form("user", user_input)

    async def async_step_reconfigure(self, user_input: dict | None = None) -> ConfigFlowResult:
        if self._get_reconfigure_entry().data["kind"] != "engine":
            return self.async_abort(reason="manage_in_lab")
        return await self.engine_form("reconfigure", user_input)

    async def engine_form(self, step: str, user_input: dict | None) -> ConfigFlowResult:
        errors = {}
        previous = self._get_reconfigure_entry() if step == "reconfigure" else None
        url = (user_input or {}).get("url") or (previous.data["url"] if previous else "http://")
        if user_input is not None:
            try:
                data = await self.connect(user_input)
            except EngineError as error:
                errors["base"] = "invalid_auth" if error.status == 401 else "cannot_connect"
            else:
                if previous:
                    if data["engine_id"] != previous.data["engine_id"]:
                        errors["base"] = "different_engine"
                    else:
                        return self.async_update_reload_and_abort(previous, data=data)
                else:
                    await self.async_set_unique_id("engine-" + data["engine_id"])
                    self._abort_if_unique_id_configured()
                    return self.async_create_entry(title="Local Forecast Engine", data=data)
        return self.async_show_form(
            step_id=step,
            data_schema=vol.Schema(
                {vol.Required("url", default=url): str, vol.Required("token"): TOKEN}
            ),
            errors=errors,
        )

    async def async_step_hassio(self, discovery_info: HassioServiceInfo) -> ConfigFlowResult:
        if not isinstance(discovery_info.config.get("url"), str) or not isinstance(
            discovery_info.config.get("token"), str
        ):
            return self.async_abort(reason="invalid_discovery")
        try:
            self.discovered = await self.connect(discovery_info.config)
        except EngineError:
            return self.async_abort(reason="cannot_connect")
        await self.async_set_unique_id("engine-" + self.discovered["engine_id"])
        self._abort_if_unique_id_configured()
        return await self.async_step_confirm_app()

    async def async_step_confirm_app(self, user_input: dict | None = None) -> ConfigFlowResult:
        if user_input is not None and self.discovered:
            self._abort_if_unique_id_configured()
            return self.async_create_entry(title="Local Forecast Engine", data=self.discovered)
        return self.async_show_form(step_id="confirm_app")

    async def async_step_import(self, user_input: dict) -> ConfigFlowResult:
        """Receive a validated draft from the authenticated Lab."""
        engine = self.hass.config_entries.async_get_entry(user_input["engine_entry_id"])
        if not engine or engine.domain != DOMAIN or engine.data["kind"] != "engine":
            return self.async_abort(reason="cannot_connect")
        project = validate_project(self.hass, user_input["project"])
        return self.async_create_entry(
            title=project["name"],
            data={"kind": "project", "engine_entry_id": engine.entry_id, "project": project},
        )
