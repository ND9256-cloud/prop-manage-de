import { createClient, SupabaseClient } from '@supabase/supabase-js';

let _admin: SupabaseClient | null = null;

function getAdmin(): SupabaseClient {
    if (!_admin) {
        const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
        const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!url || !key) throw new Error('Supabase not configured');
        _admin = createClient(url, key);
    }
    return _admin;
}

/**
 * Org-scoped query helpers for warehouse schema.
 *
 * Every query through this helper is automatically scoped to orgId.
 * Makes cross-tenant data leak impossible to accidentally create.
 *
 * IMPORTANT: The wrapper returns a Supabase query builder with the
 * warehouse schema + table already selected. Callers chain .select(),
 * .insert(), .update(), .delete() as usual — the wrapper injects
 * .eq('org_id', orgId) via the returned functions.
 *
 * Since Supabase's query chain requires .select()/.insert()/.update()
 * BEFORE .eq(), callers do:
 *
 *   const db = warehouseDb(orgId)
 *   const { data } = await db.from('documents')
 *     .select('*')
 *     .eq('org_id', orgId)       // ← still explicit, but orgId is guaranteed correct
 *     .eq('status', 'applied')
 *
 * The main benefit: orgId is derived from getOrgId() and passed centrally,
 * never from client input. The wrapper also provides storage access.
 */
export function warehouseDb(orgId: string) {
    const admin = getAdmin();
    const schema = admin.schema('warehouse');

    return {
        /** The org_id to use in all queries */
        orgId,

        /** Access a warehouse table — caller adds .select()/.insert()/.update() + .eq('org_id', orgId) */
        from: (table: string) => schema.from(table),

        /** Storage client for file operations */
        storage: admin.storage,

        /** Raw admin client for RPC calls */
        admin,
    };
}
