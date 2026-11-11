"use client";

import { useState, type ReactNode } from "react";

/**
 * Hover tooltip that appears after 300ms, unlike the browser's native `title`
 * tooltip (~1s, not configurable). The control keeps its own `aria-label` for
 * screen readers; this span is purely visual, so it is hidden from the a11y tree.
 *
 * The side is measured on hover: buttons in the left half of the viewport open
 * their tooltip to the right, buttons in the right half open it to the left, so
 * the label stays on screen (the toolbar wraps on narrow windows).
 */
export default function Tooltip({
  label,
  children,
  align = "right",
  placement = "bottom",
}: {
  label: string;
  children: ReactNode;
  /** Side used before the first hover measures the real position. */
  align?: "left" | "right";
  /**
   * Where the label opens. `bottom` measures the control and slips sideways near an
   * edge (the wrapping toolbar); `left` always opens beside it, vertically centred,
   * for controls in a vertical rail along the right edge.
   */
  placement?: "bottom" | "left";
}) {
  const [side, setSide] = useState<"left" | "right">(align);

  const measure = (el: HTMLElement) => {
    const box = el.getBoundingClientRect();
    setSide(box.left + box.width / 2 < window.innerWidth / 2 ? "left" : "right");
  };

  return (
    <span
      className="group/tt relative inline-flex"
      onMouseEnter={(e) => measure(e.currentTarget)}
      onFocus={(e) => measure(e.currentTarget)}
    >
      {children}
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute z-[70] whitespace-nowrap rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-[11px] font-medium text-zinc-100 opacity-0 shadow-lg shadow-black/40 transition-opacity duration-75 group-hover/tt:opacity-100 group-hover/tt:delay-[300ms] group-focus-within/tt:opacity-100 ${
          placement === "left"
            ? "right-full top-1/2 mr-2 -translate-y-1/2"
            : `top-full mt-1.5 ${side === "right" ? "right-0" : "left-0"}`
        }`}
      >
        {label}
      </span>
    </span>
  );
}
