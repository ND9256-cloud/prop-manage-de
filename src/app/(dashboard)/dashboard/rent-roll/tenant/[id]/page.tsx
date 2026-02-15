
import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { notFound } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ArrowLeft, Mail, Phone, User, Home, Euro, Calendar } from 'lucide-react';
import Link from 'next/link';
import { getTenantPayments } from '@/lib/bank-actions';
import TenantPaymentHistory from '@/components/tenants/tenant-payment-history';

export default async function TenantDetailPage({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    const { id } = await params;
    const session = await auth();
    if (!session?.user?.email) notFound();

    const user = await prisma.user.findUnique({
        where: { email: session.user.email },
        select: { organizationId: true },
    });
    if (!user?.organizationId) notFound();

    const person = await prisma.person.findFirst({
        where: { id, organizationId: user.organizationId },
        include: {
            leases: {
                include: {
                    unit: { include: { property: true } },
                },
                orderBy: { startDate: 'desc' },
            },
        },
    });

    if (!person) notFound();

    // Fetch initial payment history
    const paymentsResult = await getTenantPayments(person.id, 1, 10);

    const fmt = (n: number) =>
        n.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });

    const fmtDate = (d: Date | null | undefined) => {
        if (!d) return '—';
        const dt = new Date(d);
        return `${String(dt.getDate()).padStart(2, '0')}.${String(dt.getMonth() + 1).padStart(2, '0')}.${dt.getFullYear()}`;
    };

    const activeLease = person.leases.find((l) => l.status === 'ACTIVE');
    const pastLeases = person.leases.filter((l) => l.status !== 'ACTIVE');

    return (
        <main className="p-6 max-w-4xl">
            {/* Back link */}
            <Link
                href="/dashboard/rent-roll"
                className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6"
            >
                <ArrowLeft className="h-4 w-4" />
                Zurück zum Rent Roll
            </Link>

            {/* Tenant Header */}
            <div className="mb-6">
                <h1 className="text-2xl font-bold flex items-center gap-3">
                    <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
                        <User className="h-5 w-5 text-primary" />
                    </div>
                    {person.firstName} {person.lastName}
                </h1>
            </div>

            {/* Contact Info */}
            <Card className="mb-6">
                <CardHeader>
                    <CardTitle className="text-base">Kontaktdaten</CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="grid gap-4 sm:grid-cols-2">
                        <div className="flex items-center gap-3">
                            <Mail className="h-4 w-4 text-muted-foreground shrink-0" />
                            <div>
                                <p className="text-xs text-muted-foreground">E-Mail</p>
                                {person.email ? (
                                    <a href={`mailto:${person.email}`} className="text-sm font-medium text-primary hover:underline">
                                        {person.email}
                                    </a>
                                ) : (
                                    <p className="text-sm text-muted-foreground italic">nicht hinterlegt</p>
                                )}
                            </div>
                        </div>
                        <div className="flex items-center gap-3">
                            <Phone className="h-4 w-4 text-muted-foreground shrink-0" />
                            <div>
                                <p className="text-xs text-muted-foreground">Telefon</p>
                                {person.phone ? (
                                    <a href={`tel:${person.phone}`} className="text-sm font-medium">
                                        {person.phone}
                                    </a>
                                ) : (
                                    <p className="text-sm text-muted-foreground italic">nicht hinterlegt</p>
                                )}
                            </div>
                        </div>
                    </div>
                </CardContent>
            </Card>

            {/* Active Lease */}
            {activeLease && (
                <Card className="mb-6">
                    <CardHeader>
                        <CardTitle className="text-base flex items-center gap-2">
                            <span className="h-2 w-2 rounded-full bg-emerald-500" />
                            Aktiver Mietvertrag
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                            <div className="flex items-start gap-3">
                                <Home className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                                <div>
                                    <p className="text-xs text-muted-foreground">Objekt & Einheit</p>
                                    <p className="text-sm font-medium">{activeLease.unit.property.address}</p>
                                    <p className="text-xs text-muted-foreground">{activeLease.unit.unitNumber} · {activeLease.unit.sizeSqm} m²</p>
                                </div>
                            </div>
                            <div className="flex items-start gap-3">
                                <Calendar className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                                <div>
                                    <p className="text-xs text-muted-foreground">Mietdauer</p>
                                    <p className="text-sm font-medium">
                                        {fmtDate(activeLease.startDate)} — {activeLease.endDate ? fmtDate(activeLease.endDate) : 'unbefristet'}
                                    </p>
                                </div>
                            </div>
                            <div className="flex items-start gap-3">
                                <Euro className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                                <div>
                                    <p className="text-xs text-muted-foreground">Miete / mtl.</p>
                                    <div className="text-sm space-y-0.5">
                                        <p>Kaltmiete: <span className="font-medium">{fmt(activeLease.coldRent)}</span></p>
                                        <p>BK-Vorauszahlung: <span className="font-medium">{fmt(activeLease.utilityAdvance)}</span></p>
                                        <p className="border-t pt-1 mt-1">
                                            Warmmiete: <span className="font-bold">{fmt(activeLease.coldRent + activeLease.utilityAdvance)}</span>
                                        </p>
                                    </div>
                                </div>
                            </div>
                            <div>
                                <p className="text-xs text-muted-foreground">Kaution</p>
                                <p className="text-sm font-medium">{fmt(activeLease.deposit)}</p>
                            </div>
                            {activeLease.iban && (
                                <div>
                                    <p className="text-xs text-muted-foreground">IBAN</p>
                                    <p className="text-sm font-mono">{activeLease.iban}</p>
                                </div>
                            )}
                            {activeLease.rentIncreaseRule && (
                                <div>
                                    <p className="text-xs text-muted-foreground">Mieterhöhungsregel</p>
                                    <p className="text-sm font-medium">{activeLease.rentIncreaseRule}</p>
                                </div>
                            )}
                            {activeLease.lastRentIncreaseAt && (
                                <div>
                                    <p className="text-xs text-muted-foreground">Zuletzt erhöht</p>
                                    <p className="text-sm font-medium">{fmtDate(activeLease.lastRentIncreaseAt)}</p>
                                </div>
                            )}
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* Payment History */}
            <Card className="mb-6">
                <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                        <Euro className="h-4 w-4 text-muted-foreground" />
                        Zahlungshistorie
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    <TenantPaymentHistory
                        personId={person.id}
                        initialTransactions={paymentsResult.transactions as any}
                        initialTotal={paymentsResult.total}
                        initialPage={paymentsResult.page}
                        initialTotalPages={paymentsResult.totalPages}
                    />
                </CardContent>
            </Card>

            {/* Past Leases */}
            {pastLeases.length > 0 && (
                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">Vergangene Mietverträge</CardTitle>
                    </CardHeader>
                    <CardContent className="p-0">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b bg-muted/50">
                                    <th className="text-left p-3 font-medium">Objekt</th>
                                    <th className="text-left p-3 font-medium">Zeitraum</th>
                                    <th className="text-right p-3 font-medium">Kaltmiete</th>
                                    <th className="text-left p-3 font-medium">Status</th>
                                </tr>
                            </thead>
                            <tbody>
                                {pastLeases.map((lease) => (
                                    <tr key={lease.id} className="border-b">
                                        <td className="p-3">{lease.unit.property.address} · {lease.unit.unitNumber}</td>
                                        <td className="p-3">{fmtDate(lease.startDate)} — {fmtDate(lease.endDate)}</td>
                                        <td className="p-3 text-right">{fmt(lease.coldRent)}</td>
                                        <td className="p-3">
                                            <span className="text-xs px-2 py-0.5 rounded-full bg-muted">
                                                {lease.status === 'ENDED' ? 'Beendet' : lease.status}
                                            </span>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </CardContent>
                </Card>
            )}
        </main>
    );
}
