'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import { UserPlus, Trash2, RefreshCw, X, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { getRoleLabel } from '@/lib/role-labels';
import {
    updateMemberRole,
    revokeMembership,
    cancelInvitation,
    resendInvitation,
} from '@/lib/user-settings-actions';
import { inviteUser } from '@/lib/invitation-actions';

// ── Types ──────────────────────────────────────────────────

interface MemberRow {
    userId: string;
    email: string;
    name: string | null;
    role: string;
    joinedAt: string;
    isCurrentUser: boolean;
}

interface InvitationRow {
    id: string;
    email: string;
    role: string;
    expiresAt: string;
    createdAt: string;
}

interface TeamClientProps {
    members: MemberRow[];
    invitations: InvitationRow[];
}

// ── Badge Colors ──────────────────────────────────────────

function roleBadgeVariant(role: string): 'default' | 'secondary' | 'outline' | 'destructive' {
    switch (role) {
        case 'service_operator':
            return 'default';
        case 'owner':
            return 'default';
        default:
            return 'secondary';
    }
}

function roleBadgeClass(role: string): string {
    switch (role) {
        case 'service_operator':
            return 'bg-blue-100 text-blue-800 hover:bg-blue-100';
        case 'owner':
            return 'bg-purple-100 text-purple-800 hover:bg-purple-100';
        case 'manager':
            return 'bg-green-100 text-green-800 hover:bg-green-100';
        case 'viewer':
            return 'bg-gray-100 text-gray-600 hover:bg-gray-100';
        default:
            return '';
    }
}

// ── Date Formatting ───────────────────────────────────────

function fmtDate(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function fmtRelative(iso: string): string {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = d.getTime() - now.getTime();
    const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    if (diffDays <= 0) return 'Abgelaufen';
    if (diffDays === 1) return '1 Tag';
    return `${diffDays} Tage`;
}

// ── Main Component ────────────────────────────────────────

export function TeamClient({ members, invitations }: TeamClientProps) {
    const router = useRouter();
    const [isPending, startTransition] = useTransition();
    const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
    const [revokeTarget, setRevokeTarget] = useState<MemberRow | null>(null);

    // Invite form state
    const [inviteEmail, setInviteEmail] = useState('');
    const [inviteRole, setInviteRole] = useState<'viewer' | 'manager'>('viewer');

    function showFeedback(type: 'success' | 'error', message: string) {
        setFeedback({ type, message });
        setTimeout(() => setFeedback(null), 4000);
    }

    function handleRoleChange(userId: string, newRole: string) {
        startTransition(async () => {
            const result = await updateMemberRole(userId, newRole);
            if (result.success) {
                showFeedback('success', 'Rolle geändert / Role updated');
                router.refresh();
            } else {
                showFeedback('error', result.error ?? 'Fehler');
            }
        });
    }

    function handleRevoke() {
        if (!revokeTarget) return;
        const userId = revokeTarget.userId;
        setRevokeTarget(null);
        startTransition(async () => {
            const result = await revokeMembership(userId);
            if (result.success) {
                showFeedback('success', 'Mitglied entfernt / Member removed');
                router.refresh();
            } else {
                showFeedback('error', result.error ?? 'Fehler');
            }
        });
    }

    function handleCancelInvitation(id: string) {
        startTransition(async () => {
            const result = await cancelInvitation(id);
            if (result.success) {
                showFeedback('success', 'Einladung storniert / Invitation cancelled');
                router.refresh();
            } else {
                showFeedback('error', result.error ?? 'Fehler');
            }
        });
    }

    function handleResendInvitation(id: string) {
        startTransition(async () => {
            const result = await resendInvitation(id);
            if (result.success) {
                showFeedback('success', 'Einladung erneut gesendet / Invitation resent');
                router.refresh();
            } else {
                showFeedback('error', result.error ?? 'Fehler');
            }
        });
    }

    function handleInvite(e: React.FormEvent) {
        e.preventDefault();
        if (!inviteEmail.trim()) return;
        startTransition(async () => {
            const result = await inviteUser(inviteEmail.trim(), inviteRole);
            if (result.success) {
                showFeedback('success', `Einladung gesendet an ${inviteEmail}`);
                setInviteEmail('');
                router.refresh();
            } else {
                showFeedback('error', result.error ?? 'Fehler');
            }
        });
    }

    return (
        <div className="space-y-8">
            {/* Feedback toast */}
            {feedback && (
                <div
                    className={`flex items-center gap-2 px-4 py-3 rounded-lg text-sm font-medium ${feedback.type === 'success'
                            ? 'bg-green-50 text-green-800 border border-green-200'
                            : 'bg-red-50 text-red-800 border border-red-200'
                        }`}
                >
                    {feedback.type === 'success' ? (
                        <CheckCircle2 className="h-4 w-4 shrink-0" />
                    ) : (
                        <AlertCircle className="h-4 w-4 shrink-0" />
                    )}
                    {feedback.message}
                </div>
            )}

            {/* Section 1 — Members */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Mitglieder / Members</CardTitle>
                    <CardDescription>
                        {members.length} {members.length === 1 ? 'Mitglied' : 'Mitglieder'}
                    </CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b bg-muted/50">
                                    <th className="text-left p-3 font-medium">Name / E-Mail</th>
                                    <th className="text-left p-3 font-medium">Rolle</th>
                                    <th className="text-left p-3 font-medium">Seit</th>
                                    <th className="text-right p-3 font-medium">Aktionen</th>
                                </tr>
                            </thead>
                            <tbody>
                                {members.map((m) => (
                                    <tr key={m.userId} className="border-b hover:bg-muted/30 transition-colors">
                                        <td className="p-3">
                                            <div>
                                                <p className="font-medium">
                                                    {m.name || m.email}
                                                    {m.isCurrentUser && (
                                                        <span className="ml-2 text-xs text-muted-foreground">(Du)</span>
                                                    )}
                                                </p>
                                                {m.name && (
                                                    <p className="text-xs text-muted-foreground">{m.email}</p>
                                                )}
                                            </div>
                                        </td>
                                        <td className="p-3">
                                            <Badge
                                                variant={roleBadgeVariant(m.role)}
                                                className={roleBadgeClass(m.role)}
                                            >
                                                {getRoleLabel(m.role)}
                                            </Badge>
                                        </td>
                                        <td className="p-3 whitespace-nowrap text-muted-foreground">
                                            {fmtDate(m.joinedAt)}
                                        </td>
                                        <td className="p-3 text-right">
                                            {!m.isCurrentUser && m.role !== 'service_operator' && (
                                                <div className="flex items-center justify-end gap-2">
                                                    <Select
                                                        value={m.role}
                                                        onValueChange={(v) => handleRoleChange(m.userId, v)}
                                                        disabled={isPending}
                                                    >
                                                        <SelectTrigger className="w-[140px] h-8 text-xs">
                                                            <SelectValue />
                                                        </SelectTrigger>
                                                        <SelectContent>
                                                            <SelectItem value="viewer">
                                                                {getRoleLabel('viewer')}
                                                            </SelectItem>
                                                            <SelectItem value="manager">
                                                                {getRoleLabel('manager')}
                                                            </SelectItem>
                                                            <SelectItem value="owner">
                                                                {getRoleLabel('owner')}
                                                            </SelectItem>
                                                        </SelectContent>
                                                    </Select>
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        className="text-red-600 hover:text-red-700 hover:bg-red-50"
                                                        onClick={() => setRevokeTarget(m)}
                                                        disabled={isPending}
                                                    >
                                                        <Trash2 className="h-4 w-4" />
                                                    </Button>
                                                </div>
                                            )}
                                            {m.role === 'service_operator' && !m.isCurrentUser && (
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    className="text-red-600 hover:text-red-700 hover:bg-red-50"
                                                    onClick={() => setRevokeTarget(m)}
                                                    disabled={isPending}
                                                >
                                                    <Trash2 className="h-4 w-4 mr-1" />
                                                    <span className="text-xs">Entfernen</span>
                                                </Button>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </CardContent>
            </Card>

            {/* Section 2 — Pending Invitations */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Ausstehende Einladungen / Pending Invitations</CardTitle>
                </CardHeader>
                <CardContent>
                    {invitations.length === 0 ? (
                        <p className="text-sm text-muted-foreground text-center py-4">
                            Keine ausstehenden Einladungen / No pending invitations
                        </p>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b bg-muted/50">
                                        <th className="text-left p-3 font-medium">E-Mail</th>
                                        <th className="text-left p-3 font-medium">Rolle</th>
                                        <th className="text-left p-3 font-medium">Läuft ab</th>
                                        <th className="text-right p-3 font-medium">Aktionen</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {invitations.map((inv) => (
                                        <tr key={inv.id} className="border-b hover:bg-muted/30 transition-colors">
                                            <td className="p-3 font-medium">{inv.email}</td>
                                            <td className="p-3">
                                                <Badge
                                                    variant={roleBadgeVariant(inv.role)}
                                                    className={roleBadgeClass(inv.role)}
                                                >
                                                    {getRoleLabel(inv.role)}
                                                </Badge>
                                            </td>
                                            <td className="p-3 text-muted-foreground whitespace-nowrap">
                                                {fmtRelative(inv.expiresAt)}
                                            </td>
                                            <td className="p-3 text-right">
                                                <div className="flex items-center justify-end gap-1">
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        className="text-xs"
                                                        onClick={() => handleResendInvitation(inv.id)}
                                                        disabled={isPending}
                                                    >
                                                        <RefreshCw className="h-3 w-3 mr-1" />
                                                        Erneut
                                                    </Button>
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        className="text-red-600 hover:text-red-700 text-xs"
                                                        onClick={() => handleCancelInvitation(inv.id)}
                                                        disabled={isPending}
                                                    >
                                                        <X className="h-3 w-3 mr-1" />
                                                        Stornieren
                                                    </Button>
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* Section 3 — Invite Form */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Neues Mitglied einladen / Invite New Member</CardTitle>
                </CardHeader>
                <CardContent>
                    <form onSubmit={handleInvite} className="flex flex-col sm:flex-row gap-3">
                        <input
                            type="email"
                            placeholder="email@example.com"
                            value={inviteEmail}
                            onChange={(e) => setInviteEmail(e.target.value)}
                            className="flex-1 px-3 py-2 text-sm border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring"
                            required
                            disabled={isPending}
                        />
                        <Select
                            value={inviteRole}
                            onValueChange={(v) => setInviteRole(v as 'viewer' | 'manager')}
                            disabled={isPending}
                        >
                            <SelectTrigger className="w-full sm:w-[200px]">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="viewer">
                                    {getRoleLabel('viewer')} / Client
                                </SelectItem>
                                <SelectItem value="manager">
                                    {getRoleLabel('manager')} / Manager
                                </SelectItem>
                            </SelectContent>
                        </Select>
                        <Button type="submit" disabled={isPending} className="gap-2">
                            {isPending ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <UserPlus className="h-4 w-4" />
                            )}
                            Einladen
                        </Button>
                    </form>
                </CardContent>
            </Card>

            {/* Revoke Confirmation Dialog */}
            <Dialog open={!!revokeTarget} onOpenChange={(open) => !open && setRevokeTarget(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Mitglied entfernen / Remove Member</DialogTitle>
                        <DialogDescription>
                            Möchten Sie <strong>{revokeTarget?.name || revokeTarget?.email}</strong> wirklich
                            aus der Organisation entfernen? Diese Aktion kann nicht rückgängig gemacht werden.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setRevokeTarget(null)}>
                            Abbrechen
                        </Button>
                        <Button variant="destructive" onClick={handleRevoke} disabled={isPending}>
                            {isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                            Entfernen / Remove
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Loading overlay */}
            {isPending && (
                <div className="fixed bottom-6 right-6 bg-background border rounded-lg shadow-lg px-4 py-2 flex items-center gap-2 text-sm">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Wird verarbeitet...
                </div>
            )}
        </div>
    );
}
