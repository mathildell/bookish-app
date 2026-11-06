// Book types matching backend schemas

export interface BookCard {
  id: number;
  title: string;
  authors: string[];
  series_name?: string | null;
  series_index?: number | null;
  cover_uri?: string | null;
  status?: string | null;
  goodreads_rating?: number | null;
  indexed: boolean;
}

export interface BookDetail extends BookCard {
  publisher?: string | null;
  tags: string[];
  genres: string[];
  time_period: string[];
  tropes: string[];
  characters: string[];
  sex_themes: string[];
  goodreads_id?: string | null;
  goodreads_rating?: number | null;
  word_count?: number | null;
  page_count?: number | null;
  date_added?: string | null;
  date_read?: string | null;
  netgalley_deadline?: string | null;
  blurb?: string | null;
  personal_notes?: string | null;
  obsidian_review?: string | null;
}

export interface BooksListResponse {
  cards: BookCard[];
  total: number;
  offset: number;
  indexed_total: number;
  indexed_unknown?: boolean; // true when ChromaDB is down and index status may be unreliable
}

// Chat types

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
}

export interface Citation {
  calibre_id?: number;
  title: string;
}

export interface StreamToken {
  token: string;
}

export interface StreamDone {
  done: true;
  answer: string;
  citations: Citation[];
}

// ARC types

export interface ArcBook {
  calibre_id: number;
  title: string;
  authors: string[];
  cover_uri?: string | null;
  netgalley_deadline?: string | null;
  days_past_due: number;
  overdue: boolean;
  has_notes: boolean;
  has_review: boolean;
}

// Filter metadata

export interface FilterMetadata {
  statuses: string[];
}
