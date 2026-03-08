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
