// src/lib/presenter/types.ts
//
// Shared types for the Presenter (Architecture §5.4.6).
//
// The Presenter is a render-only layer. It never reads claims, OCR, the DB, or
// document metadata directly. The CALLER (typically a server action) resolves
// any side-information — like which doc_type a given source_document_id maps
// to — and passes it in via RenderHints. Without hints the presenter says
// "der hinterlegten Quelle" generically; with hints it can name the document
// type ("laut hinterlegtem Mietvertrag"). This keeps the purity contract
// intact (the presenter never touches the DB) while letting prose stay
// informative.

export interface DocumentHint {
  id: string;
  doc_type: string;
  file_name?: string;
}

export interface RenderHints {
  documents?: DocumentHint[];
}
