"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { NAV_SEARCH_SLOT_ID } from "@/lib/navSearchSlot";

/**
 * Moves a page's search bar into the navbar's centre slot.
 *
 * The page keeps owning the search state and behaviour; only the markup is rendered
 * elsewhere. Pages without a search render no portal, so the slot stays empty.
 */
export default function NavSearchPortal({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setTarget(document.getElementById(NAV_SEARCH_SLOT_ID));
  }, []);

  if (!target) return null;
  return createPortal(children, target);
}
