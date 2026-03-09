
import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Building2, Users, Home, Euro, TrendingUp, AlertCircle, ArrowRight, Calendar } from 'lucide-react';
import { getOrgContext } from '@/lib/org';

export default async function DashboardPage() {
    const session = await auth();
    if (!session?.user?.email) notFound();

    const ctx = await getOrgContext().catch(() => null);
    if (!ctx) notFound();
    const orgId = ctx.orgId;

    // Fetch all stats
    const [properties, units, persons, leases] = await Promise.all([
        prisma.property.findMany({
            where: { organizationId: orgId },
            include: { _count: { select: { units: true } } },
        }),
        prisma.unit.findMany({
            where: { property: { organizationId: orgId } },
            include: {
                leases: { where: { status: 'ACTIVE' }, select: { id: true, coldRent: true, utilityAdvance: true } },
            },
        }),
        prisma.person.count({ where: { organizationId: orgId } }),
        prisma.lease.findMany({
            where: {
                status: 'ACTIVE',
                unit: { property: { organizationId: orgId } },
            },
            include: {
                mainTenant: true,
                unit: { include: { property: true } },
            },
            orderBy: { startDate: 'desc' },
            take: 5,
        }),
    ]);

    const totalUnits = units.length;
    const occupiedUnits = units.filter(u => u.leases.length > 0).length;
    const vacantUnits = totalUnits - occupiedUnits;
    const occupancyRate = totalUnits > 0 ? Math.round((occupiedUnits / totalUnits) * 100) : 0;

    const totalMonthlyRent = units.reduce((sum, u) => {
        const lease = u.leases[0];
        return sum + (lease ? lease.coldRent + lease.utilityAdvance : 0);
    }, 0);

    const totalColdRent = units.reduce((sum, u) => {
        const lease = u.leases[0];
        return sum + (lease ? lease.coldRent : 0);
    }, 0);

    return (
        <main className="p-6">
            <div className="mb-6">
                <h1 className="text-2xl font-bold">Dashboard</h1>
                <p className="text-muted-foreground">Willkommen zurück, {session.user.name || session.user.email}</p>
            </div>

            {/* KPI Cards */}
            <div className="grid gap-4 md:grid-cols-3 lg:grid-cols-5 mb-6">
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Immobilien</CardTitle>
                        <Building2 className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{properties.length}</div>
                        <p className="text-xs text-muted-foreground">
                            {properties.reduce((sum, p) => sum + p._count.units, 0)} Einheiten gesamt
                        </p>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Auslastung</CardTitle>
                        <TrendingUp className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{occupancyRate}%</div>
                        <p className="text-xs text-muted-foreground">
                            {occupiedUnits} von {totalUnits} vermietet
                        </p>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Mieteinnahmen</CardTitle>
                        <Euro className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">
                            {totalMonthlyRent.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })}
                        </div>
                        <p className="text-xs text-muted-foreground">
                            pro Monat (inkl. NK-VZ)
                        </p>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Leerstand</CardTitle>
                        <AlertCircle className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{vacantUnits}</div>
                        <p className="text-xs text-muted-foreground">
                            Einheiten unvermietet
                        </p>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Kaltmiete/mtl.</CardTitle>
                        <Euro className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">
                            {totalColdRent.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })}
                        </div>
                    </CardContent>
                </Card>
            </div>

            <div className="grid gap-6 md:grid-cols-2">
                {/* Recent Leases */}
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center justify-between">
                            Aktive Mietverträge
                            <Link href="/dashboard/rent-roll">
                                <Button variant="ghost" size="sm">
                                    Alle anzeigen <ArrowRight className="h-4 w-4 ml-1" />
                                </Button>
                            </Link>
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        {leases.length === 0 ? (
                            <p className="text-muted-foreground text-center py-4">Keine aktiven Mietverträge</p>
                        ) : (
                            <div className="space-y-3">
                                {leases.map(lease => (
                                    <div key={lease.id} className="flex items-center justify-between p-3 border rounded-lg">
                                        <div>
                                            <p className="font-medium">
                                                {lease.mainTenant.firstName} {lease.mainTenant.lastName}
                                            </p>
                                            <p className="text-sm text-muted-foreground">
                                                {lease.unit.property.name} - {lease.unit.unitNumber}
                                            </p>
                                        </div>
                                        <div className="text-right">
                                            <p className="font-medium">
                                                {(lease.coldRent + lease.utilityAdvance).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })}
                                            </p>
                                            <p className="text-xs text-muted-foreground flex items-center justify-end gap-1">
                                                <Calendar className="h-3 w-3" />
                                                seit {new Date(lease.startDate).toLocaleDateString('de-DE')}
                                            </p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </CardContent>
                </Card>

                {/* Quick Actions */}
                <Card>
                    <CardHeader>
                        <CardTitle>Schnellaktionen</CardTitle>
                        <CardDescription>Häufig verwendete Funktionen</CardDescription>
                    </CardHeader>
                    <CardContent className="grid gap-3">
                        <Link href="/dashboard/properties">
                            <Button variant="outline" className="w-full justify-start">
                                <Building2 className="h-4 w-4 mr-2" />
                                Immobilien verwalten
                            </Button>
                        </Link>
                        <Link href="/dashboard/rent-roll">
                            <Button variant="outline" className="w-full justify-start">
                                <Users className="h-4 w-4 mr-2" />
                                Rent Roll
                            </Button>
                        </Link>
                    </CardContent>
                </Card>
            </div>
        </main >
    );
}
