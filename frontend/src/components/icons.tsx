import type { SVGProps } from "react";

/**
 * Every icon the app draws, in one place, so a view imports the shape it needs
 * instead of copy-pasting paths. A shape then only ever changes once.
 *
 * Icons take the standard SVG props: pass `className` for size and colour, or
 * override `strokeWidth` / `viewBox` where a spot needs something different.
 */
export type IconProps = SVGProps<SVGSVGElement>;

/** Shared geometry for the 24px outline set: stroked in the current text colour. */
const OUTLINE = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

/* ── navigation & chrome ─────────────────────────────────────────── */

/** Disclosure chevron. Rotate it with a wrapper class (e.g. `rotate-180`). */
export function ChevronIcon({ className = "h-3.5 w-3.5", ...props }: IconProps) {
  return (
    <svg {...OUTLINE} strokeWidth={2} className={className} {...props}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function GearIcon({ className = "h-5 w-5", ...props }: IconProps) {
  return (
    <svg {...OUTLINE} className={className} {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.14.4.4.75.74 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

export function BookmarkIcon({ className = "h-5 w-5", ...props }: IconProps) {
  return (
    <svg {...OUTLINE} className={className} {...props}>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M18.507 19.853V6.034C18.5116 5.49905 18.3034 4.98422 17.9283 4.60277C17.5532 4.22131 17.042 4.00449 16.507 4H8.50705C7.9721 4.00449 7.46085 4.22131 7.08577 4.60277C6.7107 4.98422 6.50252 5.49905 6.50705 6.034V19.853C6.45951 20.252 6.65541 20.6407 7.00441 20.8399C7.35342 21.039 7.78773 21.0099 8.10705 20.766L11.907 17.485C12.2496 17.1758 12.7705 17.1758 13.113 17.485L16.9071 20.767C17.2265 21.0111 17.6611 21.0402 18.0102 20.8407C18.3593 20.6413 18.5551 20.2522 18.507 19.853Z"
      />
    </svg>
  );
}

export function CharacterIcon({ className = "h-6 w-6", ...props }: IconProps) {
  return (
    <svg {...OUTLINE} strokeWidth={1} className={className} {...props}>
      <path fillRule="evenodd" 
        d="M3.5 8a5.5 5.5 0 118.596 4.547 9.005 9.005 0 015.9 8.18.75.75 0 01-1.5.045 7.5 7.5 0 00-14.993 0 .75.75 0 01-1.499-.044 9.005 9.005 0 015.9-8.181A5.494 5.494 0 013.5 8zM9 4a4 4 0 100 8 4 4 0 000-8z" />
      <path d="M17.29 8c-.148 0-.292.01-.434.03a.75.75 0 11-.212-1.484 4.53 4.53 0 013.38 8.097 6.69 6.69 0 013.956 6.107.75.75 0 01-1.5 0 5.193 5.193 0 00-3.696-4.972l-.534-.16v-1.676l.41-.209A3.03 3.03 0 0017.29 8z" />
    </svg>
  );
}

export function ListAdd({ className = "h-6 w-6", ...props }: IconProps) {
  return (
    <svg {...OUTLINE} viewBox="0 0 21 21" className={className} {...props}>
      <path 
        d="M3 17H10M15 16H18M18 16H21M18 16V19M18 16V13M3 12H14M3 7H14" 
      />
   </svg>
  );
}

export function ListRemove({ className = "h-6 w-6", ...props }: IconProps) {
  return (
    <svg {...OUTLINE} viewBox="0 0 21 21" className={className} {...props}>
      <path 
        d="M3 17H10M15 16H21M3 12H14M3 7H14"
      />
   </svg>
  );
}

export function FolderAdd({ className = "h-6 w-6 -ml-0.5 -mt-0.5", ...props }: IconProps) {
  return (
    <svg {...OUTLINE} viewBox="0 0 22 22" className={className} {...props}>
      <path d="M12 11L12 16" />
      <path d="M14.5 13.5L9.5 13.5" />
      <path d="M3 9.312C3 4.93757 3.93757 4 8.312 4H9.92963C10.5983 4 11.2228 4.3342 11.5937 4.8906L12.4063 6.1094C12.7772 6.6658 13.4017 7 14.0704 7C15.9647 7 17.8145 7 19.1258 7C20.1807 7 21.0128 7.82095 21.0029 8.8758C21.0013 9.05376 21 9.20638 21 9.312V14.688C21 19.0624 20.0624 20 15.688 20H8.312C3.93757 20 3 19.0624 3 14.688V9.312Z" />
   </svg>
  );
}

export function IndexAdd({ className = "h-6 w-6", ...props }: IconProps) {
  return (
    <svg {...OUTLINE} viewBox="0 0 31 31" strokeWidth={2} className={className} {...props}>
      <ellipse cx="14" cy="8" rx="10" ry="5"/>
      <circle cx="24" cy="23" r="7"/>
      <line x1="24" y1="20" x2="24" y2="26"/>
      <line x1="21" y1="23" x2="27" y2="23"/>
      <line x1="24" y1="16" x2="24" y2="8"/>
      <path d="M4,8v8c0,2.8,4.5,5,10,5c1.2,0,2.3-0.1,3.4-0.3"/>
      <path d="M4,16v8c0,2.8,4.5,5,10,5c2,0,3.8-0.3,5.3-0.8"/>
   </svg>
  );
}

export function IndexRemove({ className = "h-6 w-6", ...props }: IconProps) {
  return (
    <svg {...OUTLINE} viewBox="0 0 31 31" strokeWidth={2} className={className} {...props}>
      <circle cx="24" cy="23" r="7"/>
      <line x1="21.9" y1="20.9" x2="26.1" y2="25.1"/>
      <line x1="21.9" y1="25.1" x2="26.1" y2="20.9"/>
      <ellipse cx="14" cy="8" rx="10" ry="5"/>
      <line x1="24" y1="16" x2="24" y2="8"/>
      <path d="M4,8v8c0,2.8,4.5,5,10,5c1.2,0,2.3-0.1,3.4-0.3"/>
      <path d="M4,16v8c0,2.8,4.5,5,10,5c2,0,3.8-0.3,5.3-0.8"/>
   </svg>
  );
}

export function SearchIcon({ className = "h-4 w-4", ...props }: IconProps) {
  return (
    <svg {...OUTLINE} strokeWidth={2} className={className} {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.35-4.35" />
    </svg>
  );
}

/** Small X for clearing an input. */
export function ClearIcon({ className = "h-2.5 w-2.5", ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 15 15"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
      className={className}
      {...props}
    >
      <path d="M2 2l8 8M10 2l-8 8" />
    </svg>
  );
}

/* ── content & actions ───────────────────────────────────────────── */

/** Chat bubble with typing dots, used as the list → chat shortcut. */
export function ChatIcon({ className = "h-4 w-4 inline", ...props }: IconProps) {
  return (
    <svg {...OUTLINE} className={className} {...props}>
      <path d="M8 12H8.009M11.991 12H12M15.991 12H16" />
      <path d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 13.5997 2.37562 15.1116 3.04346 16.4525C3.22094 16.8088 3.28001 17.2161 3.17712 17.6006L2.58151 19.8267C2.32295 20.793 3.20701 21.677 4.17335 21.4185L6.39939 20.8229C6.78393 20.72 7.19121 20.7791 7.54753 20.9565C8.88837 21.6244 10.4003 22 12 22Z" />
    </svg>
  );
}

/** Open book, used for citation chips. */
export function BookIcon({ className = "h-4 w-4 flex-none", ...props }: IconProps) {
  return (
    <svg {...OUTLINE} className={className} {...props}>
      <path d="M12 6.5V18.5" />
      <path d="M20.5 6.5V18.5" />
      <path d="M3.5 6.5V18.5" />
      <path d="M20.5 18.5C20.5 18.5 19.5 16.5 16 16.5C12.5 16.5 12 18.5 12 18.5" />
      <path d="M3.5 18.5C3.5 18.5 4.5 16.5 8 16.5C11.5 16.5 12 18.5 12 18.5" />
      <path d="M20.5 6.5C20.5 6.5 19.5 4.5 16 4.5C12.5 4.5 12 6.5 12 6.5" />
      <path d="M3.5 6.5C3.5 6.5 4.5 4.5 8 4.5C11.5 4.5 12 6.5 12 6.5" />
    </svg>
  );
}

export function TrashIcon({ className = "h-4 w-4 inline", ...props }: IconProps) {
  return (
    <svg {...OUTLINE} className={className} {...props}>
      <path d="M9.1709 4C9.58273 2.83481 10.694 2 12.0002 2C13.3064 2 14.4177 2.83481 14.8295 4" />
      <path d="M20.5001 6H3.5" />
      <path d="M18.8332 8.5L18.3732 15.3991C18.1962 18.054 18.1077 19.3815 17.2427 20.1907C16.3777 21 15.0473 21 12.3865 21H11.6132C8.95235 21 7.62195 21 6.75694 20.1907C5.89194 19.3815 5.80344 18.054 5.62644 15.3991L5.1665 8.5" />
      <path d="M9.5 11L10 16" />
      <path d="M14.5 11L14 16" />
    </svg>
  );
}

export function EditIcon({ className = "h-4 w-4 inline", ...props }: IconProps) {
  return (
    <svg {...OUTLINE} className={className} {...props}>
      <path d="M14.3601 4.07866L15.2869 3.15178C16.8226 1.61607 19.3125 1.61607 20.8482 3.15178C22.3839 4.68748 22.3839 7.17735 20.8482 8.71306L19.9213 9.63993M14.3601 4.07866C14.3601 4.07866 14.4759 6.04828 16.2138 7.78618C17.9517 9.52407 19.9213 9.63993 19.9213 9.63993M14.3601 4.07866L5.83882 12.5999C5.26166 13.1771 4.97308 13.4656 4.7249 13.7838C4.43213 14.1592 4.18114 14.5653 3.97634 14.995C3.80273 15.3593 3.67368 15.7465 3.41556 16.5208L2.32181 19.8021M19.9213 9.63993L11.4001 18.1612C10.8229 18.7383 10.5344 19.0269 10.2162 19.2751C9.84082 19.5679 9.43469 19.8189 9.00498 20.0237C8.6407 20.1973 8.25352 20.3263 7.47918 20.5844L4.19792 21.6782M4.19792 21.6782L3.39584 21.9456C3.01478 22.0726 2.59466 21.9734 2.31063 21.6894C2.0266 21.4053 1.92743 20.9852 2.05445 20.6042L2.32181 19.8021M4.19792 21.6782L2.32181 19.8021" />
    </svg>
  );
}

/** Filled X, for dismissing a form. */
export function CancelIcon({ className = "h-4 w-4 inline", ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      {...props}
    >
      <path d="M20.7457 3.32851C20.3552 2.93798 19.722 2.93798 19.3315 3.32851L12.0371 10.6229L4.74275 3.32851C4.35223 2.93798 3.71906 2.93798 3.32854 3.32851C2.93801 3.71903 2.93801 4.3522 3.32854 4.74272L10.6229 12.0371L3.32856 19.3314C2.93803 19.722 2.93803 20.3551 3.32856 20.7457C3.71908 21.1362 4.35225 21.1362 4.74277 20.7457L12.0371 13.4513L19.3315 20.7457C19.722 21.1362 20.3552 21.1362 20.7457 20.7457C21.1362 20.3551 21.1362 19.722 20.7457 19.3315L13.4513 12.0371L20.7457 4.74272C21.1362 4.3522 21.1362 3.71903 20.7457 3.32851Z" />
    </svg>
  );
}

/** Filled tick, for confirming a form. */
export function ValidateIcon({ className = "h-4 w-4 inline", ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 12 18"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth={1}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      {...props}
    >
      <path d="M4.63 15.638a1.028 1.028 0 0 1-.79-.37L.36 11.09a1.03 1.03 0 1 1 1.58-1.316l2.535 3.043L9.958 3.32a1.029 1.029 0 0 1 1.783 1.03L5.52 15.122a1.03 1.03 0 0 1-.803.511.89.89 0 0 1-.088.004z" />
    </svg>
  );
}

/**
 * Selection tick used on cards. Hide it with `text-transparent` rather than not
 * rendering it, so the checkbox keeps its size.
 */
export function CheckIcon({ className = "h-3 w-3", ...props }: IconProps) {
  return (
    <svg viewBox="0 0 12 12" fill="none" aria-hidden="true" className={className} {...props}>
      <path d="M2 6L5 9L10 3" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
