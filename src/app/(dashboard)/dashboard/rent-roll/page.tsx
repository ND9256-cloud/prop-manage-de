
import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Building2, Users, Euro, Home, ArrowLeft } from 'lucide-react';
import ImportButton from '@/components/rent-roll/import-button';
import { getOrgContext } from '@/lib/org';

export default async function RentRollPage() {
    const session = await auth();
    if (!session?.user?.email) notFound();

    const ctx = await getOrgContext().catch(() => null);
    if (!ctx) notFound();
    const orgId = ctx.orgId;

    const leases = await prisma.lease.findMany({
        where: {
            status: 'ACTIVE',
            unit: { property: { organizationId: orgId } },
        },
        include: {
            mainTenant: true,
            unit: {
                include: { property: true },
            },
        },
        orderBy: [
            { unit: { property: { name: 'asc' } } },
            { unit: { floor: 'asc' } },
        ],
    });

    // --- VPI data from DB ---
    // Get the latest VPI entry
    const latestVpi = await prisma.vpiIndex.findFirst({
        orderBy: [{ year: 'desc' }, { month: 'desc' }],
    });

    // Collect all dates we need VPI for (last increase or lease start)
    const vpiDates = leases.map((l) => {
        const refDate = l.lastRentIncreaseAt ?? l.startDate;
        const dt = new Date(refDate);
        return { year: dt.getFullYear(), month: dt.getMonth() + 1 };
    });

    // Fetch all needed VPI entries in one query
    const uniqueDates = [...new Map(vpiDates.map(d => [`${d.year}-${d.month}`, d])).values()];
    const vpiEntries = await prisma.vpiIndex.findMany({
        where: { OR: uniqueDates.map(d => ({ year: d.year, month: d.month })) },
    });
    const vpiMap = new Map(vpiEntries.map(v => [`${v.year}-${v.month}`, v.value]));

    // Helper: get VPI for a date
    const getVpi = (d: Date) => {
        const dt = new Date(d);
        return vpiMap.get(`${dt.getFullYear()}-${dt.getMonth() + 1}`) ?? null;
    };

    // Stats
    const totalColdRent = leases.reduce((sum, l) => sum + l.coldRent, 0);
    const totalWarmRent = leases.reduce((sum, l) => sum + l.coldRent + l.utilityAdvance, 0);
    const totalDeposit = leases.reduce((sum, l) => sum + l.deposit, 0);

    // Generate a 3-part unit code: first 3 letters of street + house number + floor abbrev
    const unitCode = (address: string, unitNumber: string) => {
        const streetMatch = address.match(/^([A-Za-zÄÖÜäöüß]+)/);
        const streetAbbr = streetMatch ? streetMatch[1].substring(0, 3).toUpperCase() : '???';
        const houseNum = address.match(/(\d+)/);
        const house = houseNum ? houseNum[1] : '';
        // Floor abbreviation from unit name
        const floor = unitNumber
            .replace(/Erdgeschoss/i, 'EG')
            .replace(/Dachgeschoss/i, 'DG')
            .replace(/(\d+)\. Obergeschoss/i, '$1OG')
            .replace(/(\d+)\. OG/i, '$1OG');
        return `${streetAbbr}·${house}·${floor}`;
    };
    const totalArea = leases.reduce((sum, l) => sum + (l.unit.sizeSqm ?? 0), 0);
    const erv = leases.length > 0
        ? Math.max(...leases.map(l => l.unit.sizeSqm ? l.coldRent / l.unit.sizeSqm * 12 : 0))
        : 0;
    const totalErvTotal = leases.reduce((sum, l) => sum + erv * (l.unit.sizeSqm ?? 0), 0);

    const fmt = (n: number) =>
        n.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });

    const fmtDate = (d: Date | null | undefined) => {
        if (!d) return '—';
        const dt = new Date(d);
        const day = String(dt.getDate()).padStart(2, '0');
        const month = String(dt.getMonth() + 1).padStart(2, '0');
        const year = dt.getFullYear();
        return `${day}.${month}.${year}`;
    };

    const fmtPct = (pct: number | null) => {
        if (pct === null) return '—';
        const sign = pct >= 0 ? '+' : '';
        return `${sign}${pct.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} %`;
    };

    return (
        <main className="p-6">
            <Link
                href="/dashboard"
                className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4"
            >
                <ArrowLeft className="h-4 w-4" />
                Zurück zum Dashboard
            </Link>
            <div className="mb-6 flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold">Rent Roll</h1>
                    <p className="text-muted-foreground">
                        Übersicht aller aktiven Mietverhältnisse
                    </p>
                </div>
                <ImportButton />
            </div>

            {/* KPI Cards */}
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4 mb-6">
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Mietverhältnisse</CardTitle>
                        <Users className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{leases.length}</div>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Kaltmiete/mtl.</CardTitle>
                        <Euro className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{fmt(totalColdRent)}</div>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Warmmiete/mtl.</CardTitle>
                        <Euro className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{fmt(totalWarmRent)}</div>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Gesamtfläche</CardTitle>
                        <Home className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{totalArea} m²</div>
                    </CardContent>
                </Card>
            </div>

            {/* Rent Roll Table */}
            {leases.length === 0 ? (
                <Card>
                    <CardContent className="py-12 text-center">
                        <Building2 className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
                        <h3 className="text-lg font-semibold mb-2">Keine aktiven Mietverhältnisse</h3>
                        <p className="text-muted-foreground">
                            Legen Sie Immobilien, Einheiten und Mietverträge an.
                        </p>
                    </CardContent>
                </Card>
            ) : (
                <Card>
                    <CardContent className="p-0">
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b bg-muted/50">
                                        <th className="text-left p-3 font-medium whitespace-nowrap">Kennung</th>
                                        <th className="text-left p-3 font-medium whitespace-nowrap">Mieter</th>
                                        <th className="text-left p-3 font-medium whitespace-nowrap">Geschoss</th>
                                        <th className="text-right p-3 font-medium whitespace-nowrap">Wohnfläche</th>
                                        <th className="text-left p-3 font-medium whitespace-nowrap">Mietstart</th>
                                        <th className="text-right p-3 font-medium whitespace-nowrap">Kaltmiete</th>
                                        <th className="text-right p-3 font-medium whitespace-nowrap">€/m²/p.a.</th>
                                        <th className="text-right p-3 font-medium whitespace-nowrap">BK-Vorauszahlung</th>
                                        <th className="text-right p-3 font-medium whitespace-nowrap">Warmmiete</th>
                                        <th className="text-right p-3 font-medium whitespace-nowrap">ERV</th>
                                        <th className="text-right p-3 font-medium whitespace-nowrap">ERV Total</th>
                                        <th className="text-left p-3 font-medium whitespace-nowrap">Mieterhöhungsregel</th>
                                        <th className="text-left p-3 font-medium whitespace-nowrap">Zuletzt erhöht</th>

                                        <th className="text-right p-3 font-medium whitespace-nowrap">Pot. Erhöhung</th>
                                        <th className="text-right p-3 font-medium whitespace-nowrap">Kaution</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {leases.map((lease) => (
                                        <tr key={lease.id} className="border-b hover:bg-muted/30 transition-colors">
                                            <td className="p-3 whitespace-nowrap font-mono text-xs text-muted-foreground">
                                                {unitCode(lease.unit.property.address, lease.unit.unitNumber)}
                                            </td>
                                            <td className="p-3 whitespace-nowrap font-medium">
                                                <Link
                                                    href={`/dashboard/rent-roll/tenant/${lease.mainTenant.id}`}
                                                    className="text-primary hover:underline"
                                                >
                                                    {lease.mainTenant.firstName} {lease.mainTenant.lastName}
                                                </Link>
                                            </td>
                                            <td className="p-3 whitespace-nowrap">{lease.unit.unitNumber}</td>
                                            <td className="p-3 text-right whitespace-nowrap">{lease.unit.sizeSqm != null ? `${lease.unit.sizeSqm} m²` : '—'}</td>
                                            <td className="p-3 whitespace-nowrap">{fmtDate(lease.startDate)}</td>
                                            <td className="p-3 text-right whitespace-nowrap">{fmt(lease.coldRent)}</td>
                                            <td className="p-3 text-right whitespace-nowrap">{lease.unit.sizeSqm ? fmt(lease.coldRent / lease.unit.sizeSqm * 12) : '—'}</td>
                                            <td className="p-3 text-right whitespace-nowrap">{fmt(lease.utilityAdvance)}</td>
                                            <td className="p-3 text-right whitespace-nowrap font-medium">
                                                {fmt(lease.coldRent + lease.utilityAdvance)}
                                            </td>
                                            <td className="p-3 text-right whitespace-nowrap">{fmt(erv)}</td>
                                            <td className="p-3 text-right whitespace-nowrap">{lease.unit.sizeSqm != null ? fmt(erv * lease.unit.sizeSqm) : '—'}</td>
                                            <td className="p-3 whitespace-nowrap">{lease.rentIncreaseRule || '—'}</td>
                                            <td className="p-3 whitespace-nowrap">
                                                {lease.lastRentIncreaseAt
                                                    ? fmtDate(lease.lastRentIncreaseAt)
                                                    : <span className="text-muted-foreground italic">noch keine Erhöhung</span>}
                                            </td>

                                            {(() => {
                                                const refDate = lease.lastRentIncreaseAt ?? lease.startDate;
                                                const vpiRef = getVpi(refDate);
                                                const vpiNow = latestVpi?.value;
                                                const pct = vpiRef && vpiNow ? (vpiNow / vpiRef - 1) * 100 : null;
                                                return (
                                                    <td className={`p-3 text-right whitespace-nowrap font-medium ${pct !== null && pct > 0 ? 'text-emerald-600' : ''}`}>
                                                        {fmtPct(pct)}
                                                    </td>
                                                );
                                            })()}
                                            <td className="p-3 text-right whitespace-nowrap">{fmt(lease.deposit)}</td>
                                        </tr>
                                    ))}
                                    {/* Totals row */}
                                    <tr className="bg-muted/50 font-semibold">
                                        <td className="p-3" colSpan={3}>Gesamt</td>
                                        <td className="p-3 text-right">{totalArea} m²</td>
                                        <td className="p-3" colSpan={1}></td>
                                        <td className="p-3 text-right">{fmt(totalColdRent)}</td>
                                        <td className="p-3 text-right">{fmt(totalArea > 0 ? totalColdRent / totalArea * 12 : 0)}</td>
                                        <td className="p-3 text-right">
                                            {fmt(leases.reduce((s, l) => s + l.utilityAdvance, 0))}
                                        </td>
                                        <td className="p-3 text-right">{fmt(totalWarmRent)}</td>
                                        <td className="p-3 text-right">{fmt(erv)}</td>
                                        <td className="p-3 text-right">{fmt(totalErvTotal)}</td>
                                        <td className="p-3" colSpan={3}></td>
                                        <td className="p-3 text-right">{fmt(totalDeposit)}</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </CardContent>
                </Card>
            )}
        </main>
    );
}
