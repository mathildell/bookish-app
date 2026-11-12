"""CRUD routes for a named list of ids, shared by book lists and character lists.

A book list is a shelf of Calibre ids and a character list is a cast of profile
ids. They mean different things and live in different files, but the routes are
the same shape: create by name, rename, replace membership, delete.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.storage import JsonCollection


def build_list_router(
    *,
    path: str,
    store: JsonCollection,
    member_field: str,
    model: type[BaseModel],
    create_model: type[BaseModel],
    update_model: type[BaseModel],
    label: str,
) -> APIRouter:
    """Routes for `/{path}` whose records hold their ids under *member_field*."""
    not_found = f"{label} not found"

    def list_all():
        return store.all()

    def create(req):
        """Create an empty list. Name must be non-blank."""
        name = req.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Name is required")
        return store.add({"name": name, member_field: []})

    def update(list_id: int, req):
        """Rename and/or replace membership. Only supplied fields change."""
        name = (req.name or "").strip()
        members = getattr(req, member_field)

        def apply(item: dict) -> None:
            if name:
                item["name"] = name
            if members is not None:
                item[member_field] = sorted(set(members))

        updated = store.update(list_id, apply)
        if updated is None:
            raise HTTPException(status_code=404, detail=not_found)
        return updated

    def delete(list_id: int):
        """Remove the list; the books or profiles it named are untouched."""
        if not store.delete(list_id):
            raise HTTPException(status_code=404, detail=not_found)
        return {"ok": True}

    # The body models are only known at runtime, so they are attached explicitly:
    # FastAPI cannot resolve an annotation that names a closure variable.
    create.__annotations__["req"] = create_model
    update.__annotations__["req"] = update_model

    router = APIRouter()
    router.add_api_route(f"/{path}", list_all, methods=["GET"], response_model=list[model])
    router.add_api_route(f"/{path}", create, methods=["POST"], response_model=model, status_code=201)
    router.add_api_route(f"/{path}/{{list_id}}", update, methods=["PATCH"], response_model=model)
    router.add_api_route(f"/{path}/{{list_id}}", delete, methods=["DELETE"])
    return router
