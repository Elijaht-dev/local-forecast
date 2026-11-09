"""Manage published forecasts, schedules, and availability for HA."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import timedelta
from time import time

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.event import async_track_time_interval

from .client import Engine, EngineError
from .dataset import build_dataset, config_key, key_of, source_for
from .project import resolve
from .solar import current_solar

LOGGER = logging.getLogger(__name__)
TERMINAL = {"succeeded", "failed", "cancelled"}


@dataclass
class DomainData:
    engines: dict[str, Engine] = field(default_factory=dict)
    projects: dict[str, Project] = field(default_factory=dict)


class Project:
    def __init__(self, hass: HomeAssistant, entry: ConfigEntry, state: DomainData) -> None:
        self.hass = hass
        self.entry = entry
        self.state = state
        self.settings = entry.data["project"]
        self.key = config_key(self.settings)
        self.result: dict | None = None
        self.error: str | None = None
        self.warnings: list[str] = []
        self.job: dict | None = None
        self.task: asyncio.Task | None = None
        self.restore_task: asyncio.Task | None = None
        self.next_run = time() + 15
        self.listeners: set[Callable] = set()
        self.unsubscribe: Callable | None = None
        self._solar_cache: tuple[tuple[int, str], dict] | None = None

    @property
    def id(self) -> str:
        return self.entry.entry_id

    @property
    def target(self) -> str:
        return resolve(self.hass, self.settings["target"])

    @property
    def engine(self) -> Engine:
        if engine := self.state.engines.get(self.entry.data["engine_entry_id"]):
            return engine
        raise EngineError("The paired engine connection is disabled or missing")

    @property
    def enabled(self) -> bool:
        return self.settings["enabled"]

    @property
    def current(self) -> dict | None:
        result = self.result
        if not result or result.get("config_key") != self.key:
            return None
        try:
            source = source_for(
                self.hass, self.target, self.settings["mode"], self.settings["solar"]
            )
        except ValueError:
            return None
        identity = key_of(
            self.settings["target"],
            source.unit,
            source.mode,
            self.settings["solar"],
            self.settings["step_minutes"],
        )
        return result if result["series_key"] == identity else None

    @property
    def usable(self) -> bool:
        result = self.current
        return bool(
            self.enabled
            and result
            and result["points"]
            and time() < result["points"][-1]["start"] + result["step_minutes"] * 60
        )

    @property
    def status(self) -> str:
        if not self.enabled:
            return "paused"
        if self.usable:
            if (
                self.error
                or time() - self.current["issued_at"] > 120 * self.settings["refresh_minutes"]
            ):
                return "stale"
            return "ready"
        if self.current:
            return "expired"
        if self.task and not self.task.done():
            return "running"
        return "error" if self.error else "waiting"

    @callback
    def notify(self) -> None:
        for listener in tuple(self.listeners):
            listener()

    @callback
    def listen(self, listener: Callable) -> Callable:
        self.listeners.add(listener)
        return lambda: self.listeners.discard(listener)

    @callback
    def start(self) -> None:
        self.restore_task = self.entry.async_create_background_task(
            self.hass,
            self.restore(),
            f"local_forecast_restore_{self.id}",
        )
        self.unsubscribe = async_track_time_interval(self.hass, self.tick, timedelta(seconds=15))

    @callback
    def tick(self, _now) -> None:
        if self.enabled and time() >= self.next_run:
            self.refresh()
        self.notify()

    async def restore(self) -> None:
        try:
            result = await self.engine.request("GET", f"/projects/{self.id}/forecast")
            if result and (not self.result or result["issued_at"] >= self.result["issued_at"]):
                self.result = result
                if self.usable:
                    self.next_run = max(
                        self.next_run, result["issued_at"] + self.settings["refresh_minutes"] * 60
                    )
        except EngineError as error:
            self.error = str(error)
        self.notify()

    @callback
    def refresh(self) -> None:
        if not self.enabled or (self.task and not self.task.done()):
            return
        self.next_run = time() + self.settings["refresh_minutes"] * 60
        self.task = self.entry.async_create_background_task(
            self.hass,
            self.run(),
            f"local_forecast_refresh_{self.id}",
        )
        self.notify()

    async def run(self) -> None:
        engine = None
        job_id = None
        try:
            engine = self.engine
            dataset, preview = await build_dataset(self.hass, self.id, self.settings)
            self.warnings = preview["warnings"]
            self.job = await engine.request(
                "POST",
                "/forecasts",
                {"dataset": dataset, "model": self.settings["model"], "publish": True},
            )
            job_id = self.job["id"]
            async with asyncio.timeout(2400):
                while self.job["state"] not in TERMINAL:
                    await asyncio.sleep(2)
                    self.job = await engine.request("GET", f"/jobs/{job_id}")
            if self.job["state"] != "succeeded":
                raise EngineError(self.job.get("error") or "The forecast job was cancelled")
            self.result = {**self.job["result"], "id": job_id}
            self.error = None
        except asyncio.CancelledError:
            raise
        except (EngineError, ValueError, TimeoutError) as error:
            self.error = str(error) or "The forecast timed out"
        except Exception:
            LOGGER.exception("Unable to refresh forecast project %s", self.id)
            self.error = "Could not prepare the forecast. Check the Home Assistant log."
        finally:
            if job_id and self.job["state"] not in TERMINAL:
                with suppress(EngineError):
                    await engine.request("DELETE", f"/jobs/{job_id}")
            self.task = None
            self.notify()

    async def stop(self) -> None:
        if self.unsubscribe:
            self.unsubscribe()
        tasks = [task for task in (self.task, self.restore_task) if task and not task.done()]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    def public_result(self) -> dict:
        result = self.current
        if result and result["solar"]:
            result = {**result, "solar": self.solar_view(result)}
        return {
            "status": self.status,
            "error": self.error,
            "warnings": self.warnings,
            "forecast": result,
        }

    def solar_view(self, result: dict) -> dict:
        now = int(time())
        key = (now // 60, result["id"])
        if self._solar_cache is None or self._solar_cache[0] != key:
            self._solar_cache = (key, current_solar(result, now))
        return self._solar_cache[1]
