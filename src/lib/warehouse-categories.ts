export const CATEGORIES = [
    { key: 'rechtliches', de: 'Rechtliches', en: 'Legal', icon: '📁' },
    { key: 'finanzen', de: 'Finanzen', en: 'Financial', icon: '📁' },
    { key: 'kosten_rechnungen', de: 'Kosten & Rechnungen', en: 'Costs & Invoices', icon: '📁' },
    { key: 'vertraege', de: 'Verträge', en: 'Contracts', icon: '📁' },
    { key: 'instandhaltung', de: 'Instandhaltung', en: 'Maintenance', icon: '📁' },
    { key: 'behoerden', de: 'Behörden', en: 'Authority & Official', icon: '📁' },
    { key: 'medien', de: 'Medien', en: 'Photos & Plans', icon: '📁' },
] as const;

export type CategoryKey = typeof CATEGORIES[number]['key'];

/** Maps English category_hint values (from LLM extraction) to German labels */
export const CATEGORY_HINT_DE: Record<string, string> = {
    maintenance: 'Instandhaltung',
    utilities: 'Betriebskosten',
    insurance: 'Versicherung',
    management: 'Verwaltung',
    cleaning: 'Reinigung',
    other: 'Sonstiges',
    // German subcategory keys (already German, just capitalize)
    betriebskosten: 'Betriebskosten',
    heizkosten: 'Heizkosten',
    sonstiges: 'Sonstiges',
    instandhaltung: 'Instandhaltung',
    mietvertrag: 'Mietvertrag',
    mietanpassung: 'Mietanpassung',
    kuendigung: 'Kündigung',
    steuerbescheid: 'Steuerbescheid',
    energieausweis: 'Energieausweis',
    uebergabe: 'Übergabe',
    versicherung: 'Versicherung',
    hausgeld: 'Hausgeld',
    mahnung: 'Mahnung',
    bescheinigung: 'Bescheinigung',
};

export function getCategoryHintLabel(value: string | null | undefined): string {
    if (!value) return '—';
    return CATEGORY_HINT_DE[value.toLowerCase()] ?? value;
}
