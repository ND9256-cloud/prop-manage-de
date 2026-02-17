'use server';

import jwt from 'jsonwebtoken';

const API_BASE = 'https://api.enablebanking.com';

/**
 * Generate a JWT signed with the RSA private key for Enable Banking API auth.
 */
function generateJWT(): string {
    const appId = process.env.ENABLE_BANKING_APP_ID?.trim();
    const privateKey = process.env.ENABLE_BANKING_PRIVATE_KEY?.trim();

    if (!appId || !privateKey) {
        throw new Error(
            'Missing ENABLE_BANKING_APP_ID or ENABLE_BANKING_PRIVATE_KEY in environment variables'
        );
    }

    // Replace escaped newlines (from .env) with actual newlines
    const key = privateKey.replace(/\\n/g, '\n');

    const now = Math.floor(Date.now() / 1000);
    const payload = {
        iss: 'enablebanking.com',
        aud: 'api.enablebanking.com',
        iat: now,
        exp: now + 3600, // 1 hour
        sub: appId,
    };

    return jwt.sign(payload, key, { algorithm: 'RS256', keyid: appId });
}

/**
 * Make an authenticated request to the Enable Banking API.
 */
async function apiRequest(
    method: string,
    path: string,
    body?: Record<string, unknown>
): Promise<Response> {
    const token = generateJWT();

    const res = await fetch(`${API_BASE}${path}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: body ? JSON.stringify(body) : undefined,
    });

    return res;
}

// --- Types ---

export interface ASPSP {
    name: string;
    country: string;
    logo?: string;
    bic?: string;
    transaction_total_days?: string;
    psu_types?: string[];
    auth_methods?: { name: string; environment: string; }[];
}

export interface StartAuthResponse {
    url: string;
    authorization_id: string;
    psu_id_hash?: string;
}

export interface SessionAccount {
    uid: string;
    iban?: string;
    account_id?: {
        iban?: string;
    };
    identification_hash?: string;
}

export interface SessionResponse {
    session_id: string;
    accounts: SessionAccount[];
    aspsp?: { name: string; country: string };
    access?: { valid_until?: string };
}

export interface TransactionAmount {
    currency: string;
    amount: string;
}

export interface Transaction {
    entry_reference?: string;
    transaction_id?: string;
    booking_date?: string;
    value_date?: string;
    transaction_date?: string;
    transaction_amount?: TransactionAmount;
    credit_debit_indicator?: string; // "CRDT" or "DBIT"
    creditor?: { name?: string };
    creditor_account?: { iban?: string };
    debtor?: { name?: string };
    debtor_account?: { iban?: string };
    remittance_information?: string[];
    bank_transaction_code?: { description?: string; code?: string };
    status?: string;
}

export interface TransactionsResponse {
    transactions: Transaction[];
    continuation_key?: string;
}

export interface AccountDetails {
    uid?: string;
    iban?: string;
    owner_name?: string;
    name?: string;
    product?: string;
    cash_account_type?: string;
}

// --- Public API Functions ---

/**
 * List available banks (ASPSPs) for a country.
 */
export async function listAspsps(country: string = 'DE'): Promise<ASPSP[]> {
    const res = await apiRequest('GET', `/aspsps?country=${country}`);
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Failed to list ASPSPs: ${res.status} ${err}`);
    }
    const data = await res.json();
    return data.aspsps || data;
}

/**
 * Start user authorization — returns a URL to redirect the user to.
 */
export async function startAuthorization(
    aspspName: string,
    aspspCountry: string,
    redirectUrl: string,
    state: string
): Promise<StartAuthResponse> {
    const validUntil = new Date();
    validUntil.setDate(validUntil.getDate() + 90); // 90 day access

    const res = await apiRequest('POST', '/auth', {
        access: {
            valid_until: validUntil.toISOString(),
        },
        aspsp: {
            name: aspspName,
            country: aspspCountry,
        },
        state,
        redirect_url: redirectUrl,
        psu_type: 'personal',
        language: 'de',
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Failed to start authorization: ${res.status} ${err}`);
    }

    return res.json();
}

/**
 * Create a session after the user returns from bank auth.
 * The `code` comes from the callback query parameters.
 */
export async function createSession(code: string): Promise<SessionResponse> {
    const res = await apiRequest('POST', '/sessions', { code });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Failed to create session: ${res.status} ${err}`);
    }

    return res.json();
}

/**
 * Get account details (IBAN, owner name).
 */
export async function getAccountDetails(accountId: string): Promise<AccountDetails> {
    const res = await apiRequest('GET', `/accounts/${accountId}`);

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Failed to get account details: ${res.status} ${err}`);
    }

    return res.json();
}

/**
 * Fetch transactions for an account. Supports pagination via continuation_key.
 */
export async function getAccountTransactions(
    accountId: string,
    dateFrom?: string,
    continuationKey?: string
): Promise<TransactionsResponse> {
    let path = `/accounts/${accountId}/transactions`;
    const params: string[] = [];
    if (dateFrom) params.push(`date_from=${dateFrom}`);
    if (continuationKey) params.push(`continuation_key=${continuationKey}`);
    if (params.length > 0) path += `?${params.join('&')}`;

    const res = await apiRequest('GET', path);

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Failed to get transactions: ${res.status} ${err}`);
    }

    return res.json();
}
