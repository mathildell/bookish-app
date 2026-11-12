// Application settings, mirroring AppSettingsResponse in backend/schemas.py.

export interface AppSettings {
  calibre_db_path: string;
  calibre_url: string;
  obsidian_vault_path: string;
  chroma_db_path: string;
  ollama_host: string;
  ollama_port: number;
  chat_model: string;
  extraction_model: string;
  writing_model: string;
  writing_temperature: number;
  writing_top_p: number;
  writing_num_predict: number;
  chat_num_ctx: number;
  chat_num_predict: number;
  embedding_model: string;
  chunk_size: number;
  chunk_overlap: number;
  top_k: number;
  ignored_books: string[];
  genre_colors: Record<string, string>;
  /** Derived from the library on every read; never saved. */
  genre_categories: string[];
}

/** Models installed on the configured Ollama host. */
export interface OllamaModelList {
  models: string[];
  host: string;
  error: string | null;
}
