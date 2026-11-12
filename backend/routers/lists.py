"""Book list endpoints — user-curated shelves of Calibre ids (`data/lists.json`)."""

from backend.list_router import build_list_router
from backend.schemas import BookList, CreateListRequest, UpdateListRequest
from backend.storage import book_lists

router = build_list_router(
    path="lists",
    store=book_lists,
    member_field="book_ids",
    model=BookList,
    create_model=CreateListRequest,
    update_model=UpdateListRequest,
    label="List",
)
