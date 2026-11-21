"""The grid's ``Setup.recordInvalidate`` (plan 7's ``invalidate-once`` row): each event a client's
``on_invalidate`` (``AsyncSDK``) or ``on_invalidate_sync`` (``SDK``) hooks see, recorded in the grid's
``InvalidateObserved`` shape after a hook that raises when ``failFirst``, and each data answer observed as
``invalidated`` with the events recorded since the call before it."""

from __future__ import annotations

from typing import Any

from protocol import Observed, Setup


class HookFailure(Exception):
    """What the hook ``failFirst`` puts before the recording one raises: on_log's, never the call's."""


def failing(event: Any) -> None:
    raise HookFailure("driver: a failing on_invalidate hook")


async def failing_async(event: Any) -> None:
    failing(event)


class Invalidations:
    """The events recorded since the last call's observation."""

    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    def record(self, event: Any) -> None:
        targets = [
            {"operationId": t.operation_id, "params": dict(t.params)}
            for t in event.targets
        ]
        self.events.append({"by": event.by, "targets": targets})

    async def record_async(self, event: Any) -> None:
        self.record(event)

    def observe(self, observed: Observed | None) -> Any:
        """``observed`` as the grid reads it under the recorder: a data answer is ``invalidated``."""
        if observed is None or observed["kind"] != "data":
            return observed
        events, self.events = self.events, []
        return {**observed, "events": events, "kind": "invalidated"}


def recording(
    setup: Setup, fields: dict[str, Any], client: str
) -> Invalidations | None:
    """The recorder ``setup`` asks for, its hooks put in ``fields`` for ``client``; none without it."""
    asked = setup.get("recordInvalidate")
    if asked is None:
        return None
    recorder = Invalidations()
    sync = client == "sync"
    first = [failing if sync else failing_async] if asked["failFirst"] else []
    hooks = [*first, recorder.record if sync else recorder.record_async]
    fields["on_invalidate_sync" if sync else "on_invalidate"] = hooks
    return recorder
