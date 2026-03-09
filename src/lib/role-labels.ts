/**
 * Role display labels — never show raw role values to users.
 * Use getRoleLabel() everywhere roles appear in UI.
 */

export const ROLE_LABELS: Record<string, { de: string; en: string }> = {
    service_operator: {
        de: 'Service Operator',
        en: 'Service Operator',
    },
    owner: {
        de: 'Admin',
        en: 'Admin',
    },
    manager: {
        de: 'Verwalter',
        en: 'Manager',
    },
    viewer: {
        de: 'Eigentümer',
        en: 'Client',
    },
};

export function getRoleLabel(role: string, locale: 'de' | 'en' = 'de'): string {
    return ROLE_LABELS[role]?.[locale] ?? role;
}
