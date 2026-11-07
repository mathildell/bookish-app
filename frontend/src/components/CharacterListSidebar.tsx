"use client";

import Link from "next/link";
import ListSection, { LIST_ICON, type ListSectionItem } from "@/components/ListSection";
import {
  createCharacterList,
  deleteCharacterList,
  renameCharacterList,
  useCharacterLists,
} from "@/lib/api";
import type { Character } from "@/types/character";

/**
 * The characters page's list column. Character lists are casts, not shelves —
 * but the section itself is the same component the library uses, so chevron,
 * counts, the active-list notice and inline editing stay in step.
 */
export default function CharacterListSidebar({
  characters,
  activeListId,
  onPick,
}: {
  characters: Character[];
  activeListId: number | null;
  onPick: (id: number | null) => void;
}) {
  const { data: lists, isLoading } = useCharacterLists();

  // Only live members: a deleted profile inflates neither the count nor the ✨ link.
  const alive = new Set(characters.map((c) => c.id));
  const items: ListSectionItem[] | undefined = lists?.map((list) => ({
    id: list.id,
    name: list.name,
    ids: list.character_ids.filter((id) => alive.has(id)),
  }));

  return (
    <ListSection
      title="Lists"
      unit="character"
      lists={items}
      isLoading={isLoading}
      activeListId={activeListId}
      onPick={onPick}
      queryKey={["characterLists"]}
      onCreate={createCharacterList}
      onRename={renameCharacterList}
      onDelete={deleteCharacterList}
      shortcut={(list) =>
        list.ids.length > 0 ? (
          <Link
            href={{ pathname: "/write", query: { chars: list.ids.join(",") } }}
            title={`Write a scene with the ${list.ids.length} character${
              list.ids.length === 1 ? "" : "s"
            } in "${list.name}"`}
            className={`${LIST_ICON} text-zinc-400 hover:border-zinc-600 hover:text-yellow-400`}
          >
            ✨
          </Link>
        ) : (
          <button
            type="button"
            disabled
            title="This list has no characters yet"
            className={`${LIST_ICON} cursor-not-allowed text-zinc-600 opacity-40`}
          >
            ✨
          </button>
        )
      }
    />
  );
}
