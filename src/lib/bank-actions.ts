/**
 * Barrel re-export so existing imports from '@/lib/bank-actions' keep working.
 *
 * bank-connections.ts — connection management, sync, queries
 * bank-assignment.ts — auto-detection, assignment, analytics
 */

export {
    getAvailableBanks,
    startBankConnection,
    completeBankConnection,
    deleteBankConnection,
    syncBankTransactions,
    syncAllBankAccounts,
    getBankConnections,
    getBankAccount,
    getBankTransactions,
    getTenantPayments,
    getAssignmentOptions,
} from './bank-connections';

export {
    assignTransaction,
    autoAssignNewTransactions,
    getPropertyCashFlow,
    getServiceProviderCosts,
} from './bank-assignment';
