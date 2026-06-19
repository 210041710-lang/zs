"""Boss Zhipin page actions.

All iframe access goes through page.evaluate() directly
(querying iframe.contentDocument from the stable main page).
"""

from __future__ import annotations

import asyncio
import logging
import random
from typing import Any, Optional, Callable, Awaitable

from playwright.async_api import Page

from rpa.human_simulator import random_delay

logger = logging.getLogger(__name__)

BOSS_RECOMMEND_URL = "https://www.zhipin.com/web/chat/recommend"
BOSS_CHAT_URL = "https://www.zhipin.com/web/chat"

_notify_callback: Optional[Callable[[str, str], Awaitable[None]]] = None


def set_notify_callback(cb: Callable[[str, str], Awaitable[None]]) -> None:
    global _notify_callback
    _notify_callback = cb


async def _notify(event: str, message: str) -> None:
    if _notify_callback:
        try:
            await _notify_callback(event, message)
        except Exception:
            pass


def _is_login_page(url: str) -> bool:
    return "/web/user/" in url or "/login" in url


# ── iframe access via main page's contentDocument ─────────────────────
# Every call uses page.evaluate() with a fresh DOM lookup — no stale refs.

_IFRAME_DOC = """
(() => {
    const iframe = document.querySelector('iframe[src*="frame/recommend"]');
    if (!iframe || !iframe.contentDocument || !iframe.contentDocument.body) return null;
    return iframe.contentDocument;
})()
"""


_IFR_TEMPLATE = """(function() {
    const iframe = document.querySelector('iframe[src*="frame/recommend"]');
    if (!iframe || !iframe.contentDocument || !iframe.contentDocument.body) return null;
    const doc = iframe.contentDocument;
    __CODE__
})()"""


async def _ifr(page: Page, code: str) -> Any:
    """Run JS in the recommend iframe. `doc` refers to iframe.contentDocument."""
    js = _IFR_TEMPLATE.replace("__CODE__", code)
    for _ in range(5):
        try:
            result = await page.evaluate(js)
            if result is None:
                await asyncio.sleep(2)
                continue
            return result
        except Exception as e:
            logger.debug("_ifr retry: %s (%s)", type(e).__name__, e)
            await asyncio.sleep(2)
    return None


# ── Navigation & Login ─────────────────────────────────────────────────

async def ensure_logged_in(page: Page) -> None:
    logger.info("Opening recommend page...")
    if "/web/chat/recommend" not in page.url:
        await page.goto(BOSS_RECOMMEND_URL, wait_until="networkidle", timeout=60_000)
    await asyncio.sleep(8)

    if _is_login_page(page.url):
        await _wait_for_user_login(page)
        await page.goto(BOSS_RECOMMEND_URL, wait_until="networkidle", timeout=60_000)
        await asyncio.sleep(8)

    # Brief poll just to confirm the page is responsive
    for _ in range(10):
        n = await _ifr(page, "return doc.querySelectorAll('li.card-item').length")
        if n and n > 0:
            logger.info("%d cards visible", n)
            return
        await asyncio.sleep(2)
    logger.warning("Cards not visible yet")


async def navigate_to_recommend(page: Page) -> None:
    await ensure_logged_in(page)


async def _wait_for_user_login(page: Page, timeout: int = 300) -> None:
    await _notify("login_required", "请在弹出的 Chrome 窗口中登录 Boss 直聘")
    logger.info("Waiting for login...")
    for _ in range(timeout // 5):
        try:
            u = page.url
        except Exception:
            await asyncio.sleep(5)
            continue
        if not _is_login_page(u) and "/web/" in u:
            logger.info("Login detected!")
            await asyncio.sleep(3)
            return
        await asyncio.sleep(5)
    raise Exception("Login timed out")


# ── Card Operations ────────────────────────────────────────────────────

async def get_candidate_cards(page: Page) -> list[dict[str, Any]]:
    data = await _ifr(page, """
        return Array.from(doc.querySelectorAll('li.card-item')).map(function(card, i) {
            function t(el) { return (el && el.textContent || '').trim(); }
            var tags = [];
            card.querySelectorAll('.tag-item').forEach(function(tt) { tags.push(t(tt)); });
            var inner = card.querySelector('.card-inner');
            return {
                card_index: i,
                geek_id: String(inner ? (inner.getAttribute('data-geekid') || '') : ''),
                name: t(card.querySelector('.name')),
                active: t(card.querySelector('.active-text')),
                salary: t(card.querySelector('.salary-wrap span')),
                base_info: t(card.querySelector('.base-info')),
                expect: t(card.querySelector('.expect-wrap .content')),
                advantages: t(card.querySelector('.geek-desc .content')),
                tags: tags
            };
        }).filter(function(c) { return c.name; })
    """)
    if not data:
        return []
    logger.info("Found %d cards", len(data))
    return data


async def click_greet_button(page: Page, geek_id: str) -> bool:
    """Click '打招呼' via iframe contentDocument + MouseEvent (Vue compatible).

    No Playwright locators — all DOM access through contentDocument to avoid
    frame detachment issues caused by React re-renders.
    """
    code = f"""
        var inner = doc.querySelector('.card-inner[data-geekid=\"{geek_id}\"]');
        if (!inner) return 'no card';
        var li = inner.closest('li.card-item');
        if (!li) return 'no li';
        var btn = li.querySelector('button.btn.btn-greet');
        if (!btn) return 'no btn';
        btn.dispatchEvent(new MouseEvent('mousedown', {{bubbles: true, cancelable: true}}));
        btn.dispatchEvent(new MouseEvent('mouseup', {{bubbles: true, cancelable: true}}));
        btn.dispatchEvent(new MouseEvent('click', {{bubbles: true, cancelable: true}}));
        // Also click the parent wrapper (operate-side div)
        var wrapper = li.querySelector('.operate-side');
        if (wrapper) wrapper.click();
        return 'clicked';
    """

    for _ in range(5):
        result = await _ifr(page, code)
        if result == 'clicked':
            logger.info("Greeted geek_id=%s", geek_id[:24])
            await asyncio.sleep(3)
            return True
        logger.warning("Greet retry (%s): %s", geek_id[:24], result)
        await asyncio.sleep(2)
    return False


async def dismiss_greet_dialog(page: Page) -> bool:
    """Dismiss dialog by clicking '知道了' via contentDocument (no stale frame refs)."""
    await asyncio.sleep(1)
    for _ in range(8):
        # Try iframe contentDocument first (dialog is rendered there)
        ok = await _ifr(page, """
            var all = doc.querySelectorAll('button, span, a, div');
            for (var i = 0; i < all.length; i++) {
                var t = (all[i].textContent || '').trim();
                if ((t === '知道了' || t === '确定') && all[i].offsetParent && all[i].getBoundingClientRect().width > 10) {
                    all[i].dispatchEvent(new MouseEvent('mousedown', {bubbles: true}));
                    all[i].dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));
                    all[i].dispatchEvent(new MouseEvent('click', {bubbles: true}));
                    return 'dismissed ' + t;
                }
            }
            // Also try to click the 'X' close button
            var close = doc.querySelector('.close, .icon-close, [class*=close]');
            if (close && close.offsetParent) { close.dispatchEvent(new MouseEvent('click', {bubbles: true})); return 'closed via X'; }
            return 'not found';
        """)
        if ok and 'dismissed' in str(ok):
            logger.info("Dialog dismissed via _ifr")
            await asyncio.sleep(1)
            return True

        # Try main page
        ok = await page.evaluate("""() => {
            var btns = document.querySelectorAll('button');
            for (var i = 0; i < btns.length; i++) {
                var t = (btns[i].textContent || '').trim();
                if ((t === '知道了' || t === '确定') && btns[i].offsetParent) {
                    btns[i].dispatchEvent(new MouseEvent('click', {bubbles: true}));
                    return 'dismissed ' + t;
                }
            }
            return 'not found';
        }""")
        if ok and 'dismissed' in str(ok):
            logger.info("Dialog dismissed (main page)")
            await asyncio.sleep(1)
            return True

        await asyncio.sleep(1.5)
    return False


async def get_candidate_profile(page: Page) -> dict[str, Any]:
    cards = await get_candidate_cards(page)
    return cards[0] if cards else {}


async def scroll_to_load_more(page: Page) -> None:
    await _ifr(page, """
        var list = doc.querySelector('.card-list');
        var el = list || doc.body;
        el.scrollIntoView({block: 'end', behavior: 'smooth'});
    """)
    await asyncio.sleep(2)
    await random_delay(1.5, 3.0)


# ── Chat helpers ───────────────────────────────────────────────────────

async def navigate_to_chat(page: Page) -> None:
    await page.goto(BOSS_CHAT_URL, wait_until="domcontentloaded", timeout=30_000)
    await random_delay(1.5, 3.0)


async def get_unread_messages(page: Page) -> list[dict[str, Any]]:
    return []


async def send_chat_message(page: Page, message: str) -> bool:
    return False


async def check_for_resume_attachment(page: Page) -> Optional[str]:
    return None
