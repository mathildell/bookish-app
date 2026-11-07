// Character profile types matching backend schemas.
//
// Profiles are personality-first: the fields describe who a character is, not the
// world they came from, so the same card can be cast into an unrelated setting.
// `situationalAnchors` holds the non-portable canon and is never fed to the writing prompt.

export interface CharacterMotivations {
  wants: string;
  needs: string;
}

export interface CharacterVoice {
  /** Speech register (formality, diction). */
  tone: string;
  rhythm: string;
  tells: string[];
  humour: string;
}

export interface CharacterAppearance {
  signature: string;
  presentation: string;
}

export interface RelationshipPattern {
  dynamic: string;
  behaviour: string;
}

export interface Character {
  id: number;
  name: string;
  aliases: string[];
  role?: string | null;
  archetype?: string | null;
  summary?: string | null;
  core_traits: string[];
  motivations: CharacterMotivations;
  fears: string[];
  flaws: string[];
  values: string[];
  voice: CharacterVoice;
  mannerisms: string[];
  appearance: CharacterAppearance;
  relationships: RelationshipPattern[];
  formative_experience?: string | null;
  arc_pattern?: string | null;
  situational_anchors: string[];
  thumbnail?: string | null;
  status: string;
  error?: string | null;
  model?: string | null;
  source_book_ids: number[];
  created_at: string;
  updated_at: string;
}

/** Everything writable on a profile. */
export type CharacterInput = Omit<Character, "id" | "created_at" | "updated_at">;
