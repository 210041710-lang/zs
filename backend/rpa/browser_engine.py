"""Module 2 – RPA Browser Engine.

Launches Chrome via subprocess (normal user Chrome) then connects CDP.
No init scripts injected — the browser is indistinguishable from a real user.
"""

from __future__ import annotations

import asyncio
import logging
import subprocess
from pathlib import Path
from typing import Optional

from playwright.async_api import (
    Browser,
    BrowserContext,
    Page,
    Playwright,
    async_playwright,
)

logger = logging.getLogger(__name__)

RPA_PROFILE = "./data/chrome_rpa_profile"
DEBUG_PORT = 9222


class BrowserEngine:

    def __init__(self) -> None:
        self._playwright: Optional[Playwright] = None
        self._browser: Optional[Browser] = None
        self._context: Optional[BrowserContext] = None
        self._proc: Optional[subprocess.Popen] = None  # type: ignore[type-arg]

    async def launch(self) -> Page:
        profile = str(Path(RPA_PROFILE).resolve())
        Path(profile).mkdir(parents=True, exist_ok=True)

        subprocess.run(["pkill", "-f", f"remote-debugging-port={DEBUG_PORT}"], capture_output=True)
        await asyncio.sleep(1.5)

        logger.info("Launching Chrome (profile=%s)", profile)

        self._proc = subprocess.Popen(
            [
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                f"--remote-debugging-port={DEBUG_PORT}",
                f"--user-data-dir={profile}",
                "--no-first-run",
                "about:blank",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

        cdp_url = f"http://localhost:{DEBUG_PORT}"
        for i in range(20):
            try:
                import httpx
                resp = httpx.get(f"{cdp_url}/json/version", timeout=3)
                if resp.status_code == 200:
                    logger.info("CDP ready after %ds", i)
                    break
            except Exception:
                pass
            await asyncio.sleep(1)
        else:
            raise RuntimeError(f"CDP not reachable at {cdp_url}")

        self._playwright = await async_playwright().start()
        self._browser = await self._playwright.chromium.connect_over_cdp(cdp_url)
        self._context = self._browser.contexts[0] if self._browser.contexts else None
        if not self._context:
            self._context = await self._browser.new_context()

        page = self._context.pages[0] if self._context.pages else await self._context.new_page()

        # NO init scripts — real Chrome is already undetectable
        logger.info("Browser ready")
        return page

    async def new_page(self) -> Page:
        if not self._context:
            raise RuntimeError("Not launched")
        return await self._context.new_page()

    async def close(self) -> None:
        if self._playwright:
            await self._playwright.stop()
        if self._proc:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._proc.kill()
        logger.info("Browser shut down")

    @property
    def context(self) -> Optional[BrowserContext]:
        return self._context
