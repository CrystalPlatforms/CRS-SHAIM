/** Mirror of the Rust `store::Conversation` — keep both in sync. */
export interface Conversation {
  id: number;
  title: string;
  mode: string;
  created_at: number;
  updated_at: number;
}
