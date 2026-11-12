"""Character list endpoints — casts of profile ids (`data/character_lists.json`).

Deliberately separate from book lists: a cast and a shelf share nothing but their
shape, so they get their own routes and their own file.
"""

from backend.list_router import build_list_router
from backend.schemas import (
    CharacterList,
    CreateCharacterListRequest,
    UpdateCharacterListRequest,
)
from backend.storage import character_lists

router = build_list_router(
    path="character-lists",
    store=character_lists,
    member_field="character_ids",
    model=CharacterList,
    create_model=CreateCharacterListRequest,
    update_model=UpdateCharacterListRequest,
    label="Character list",
)
