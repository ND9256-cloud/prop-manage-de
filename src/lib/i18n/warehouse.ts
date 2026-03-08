export const t = {
    inbox: { de: 'Posteingang', en: 'Inbox' },
    allDocuments: { de: 'Alle Dokumente', en: 'All Documents' },
    needsReview: { de: 'Prüfung nötig', en: 'Needs Review' },
    applied: { de: 'Verbucht', en: 'Applied' },
    queued: { de: 'Warteschlange', en: 'Queued' },
    processing: { de: 'Verarbeitung', en: 'Processing' },
    failed: { de: 'Fehlgeschlagen', en: 'Failed' },
    quarantined: { de: 'Quarantäne', en: 'Quarantined' },
    property: { de: 'Immobilie', en: 'Property' },
    category: { de: 'Kategorie', en: 'Category' },
    status: { de: 'Status', en: 'Status' },
    confidence: { de: 'Konfidenz', en: 'Confidence' },
    date: { de: 'Datum', en: 'Date' },
    source: { de: 'Quelle', en: 'Source' },
    document: { de: 'Dokument', en: 'Document' },
    noDocuments: { de: 'Keine Dokumente', en: 'No documents' },
    noDocumentsYet: { de: 'Noch keine Dokumente eingegangen', en: 'No documents received yet' },
    upload: { de: 'Hochladen', en: 'Upload' },
    export: { de: 'Exportieren', en: 'Export' },
    search: { de: 'Suchen...', en: 'Search...' },
    high: { de: 'Hoch', en: 'High' },
    medium: { de: 'Mittel', en: 'Medium' },
    low: { de: 'Niedrig', en: 'Low' },
    total: { de: 'Gesamt', en: 'Total' },
    appliedThisMonth: { de: 'Verbucht diesen Monat', en: 'Applied this month' },
    showing: { de: 'Zeige', en: 'Showing' },
    of: { de: 'von', en: 'of' },
    documents: { de: 'Dokumenten', en: 'Documents' },
    previous: { de: 'Zurück', en: 'Previous' },
    next: { de: 'Weiter', en: 'Next' },
    selected: { de: 'ausgewählt', en: 'selected' },
    assignProperty: { de: 'Immobilie zuweisen', en: 'Assign Property' },
    quarantine: { de: 'Quarantäne', en: 'Quarantine' },
    delete: { de: 'Löschen', en: 'Delete' },
    clearFilters: { de: 'Filter zurücksetzen', en: 'Clear filters' },
    allStatuses: { de: 'Alle Status', en: 'All statuses' },
    allProperties: { de: 'Alle Immobilien', en: 'All properties' },
    allTypes: { de: 'Alle Typen', en: 'All types' },
    allSources: { de: 'Alle Quellen', en: 'All sources' },
    thisWeek: { de: 'Diese Woche', en: 'This week' },
    thisMonth: { de: 'Dieser Monat', en: 'This month' },
    last3Months: { de: 'Letzte 3 Monate', en: 'Last 3 months' },
    allTime: { de: 'Gesamter Zeitraum', en: 'All time' },
    viewDocument: { de: 'Dokument ansehen', en: 'View document' },
    copyFilename: { de: 'Dateiname kopieren', en: 'Copy filename' },
    download: { de: 'Herunterladen', en: 'Download' },
    confirmDelete: { de: 'Wirklich löschen?', en: 'Confirm delete?' },
    confirmDeleteMessage: {
        de: 'Dieses Dokument wird als gelöscht markiert. Diese Aktion kann nicht rückgängig gemacht werden.',
        en: 'This document will be marked as deleted. This action cannot be undone.',
    },
    cancel: { de: 'Abbrechen', en: 'Cancel' },
    provenance: { de: 'Herkunft', en: 'Provenance' },
    extractedBy: { de: 'Extrahiert von', en: 'Extracted by' },
    appliedBy: { de: 'Verbucht von', en: 'Applied by' },
    viaEmail: { de: 'Via E-Mail', en: 'Via Email' },
    viaTelegram: { de: 'Via Telegram', en: 'Via Telegram' },
    webUpload: { de: 'Web Upload', en: 'Web Upload' },
    unassigned: { de: 'Nicht zugeordnet', en: 'Unassigned' },
} as const;

export type TranslationKey = keyof typeof t;

/** Show both languages: "DE / EN" */
export function bilingual(key: TranslationKey): string {
    return `${t[key].de} / ${t[key].en}`;
}

/** Get a single language value */
// Future: export function lang(key: TranslationKey, locale: 'de' | 'en') {
//   return t[key][locale];
// }
