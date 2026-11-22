// Worldbuilding sheet types matching backend schemas.
//
// A world is the setting-level counterpart of a character profile: the rules and
// conventions of a fictional universe, extracted from books and cast into new stories.

export interface WorldTerm {
  term: string;
  meaning: string;
}

export interface WorldInput {
  name: string;
  premise: string | null;
  /** URL of the world's picture; empty means "use the collage of its source covers". */
  image?: string | null;
  rules: string[];
  social_structure: string[];
  tropes: string[];
  settings: string[];
  terminology: WorldTerm[];
  tensions: string[];
  variants: string[];
  locked_fields: string[];
  /** Disagreements between sources that the writer has settled (the decision taken). */
  decisions?: string[];
  source_book_ids: number[];
  /** Calibre id -> "emphasise" | "primary"; a book that is absent reads as normal. */
  source_weights: Record<string, string>;
}

/** How much reading stands behind a generated sheet. */
export interface WorldEvidence {
  notes: number;
  passages: number;
  passes: number;
}

export interface World extends WorldInput {
  id: number;
  status: string;
  evidence?: WorldEvidence | null;
  error?: string | null;
  model?: string | null;
  created_at: string;
  updated_at: string;
}
