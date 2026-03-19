
import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, Edit, Home, Plus, Users, Trash2, UserPlus } from 'lucide-react';
import PropertyForm from '@/components/properties/property-form';
import UnitForm from '@/components/properties/unit-form';
import LeaseForm from '@/components/tenants/lease-form';
import DocumentList from '@/components/documents/document-list';
import ServiceProviderList from '@/components/properties/service-provider-list';
import PropertyCashFlow from '@/components/properties/property-cash-flow';
import { deleteProperty } from '@/lib/property-actions';
import { getPropertyCashFlow, getServiceProviderCosts } from '@/lib/bank-actions';
import { getOrgContext } from '@/lib/org';
import { getSupabaseAdmin } from '@/lib/supabase';

interface PageProps {
    params: Promise<{ id: string }>;
}

export default async function PropertyDetailPage({ params }: PageProps) {
    const { id: propertyId } = await params;

    const session = await auth();
    if (!session?.user?.email) notFound();

    const ctx = await getOrgContext().catch(() => null);
    if (!ctx) notFound();
    const orgId = ctx.orgId;

    const property = await prisma.property.findFirst({
        where: {
            id: propertyId,
            organizationId: orgId,
        },
        include: {
            units: {
                include: {
                    leases: {
                        where: { status: 'ACTIVE' },
                        include: { mainTenant: true },
                    },
                },
                orderBy: { unitNumber: 'asc' },
            },
            serviceProviders: {
                orderBy: { category: 'asc' },
            },
        },
    });

    if (!property) {
        notFound();
    }

    // Get all persons for lease creation
    const persons = await prisma.person.findMany({
        where: { organizationId: orgId },
        orderBy: { lastName: 'asc' },
    });

    const totalSqm = property.units.reduce((sum, u) => sum + u.sizeSqm, 0);
    const occupiedUnits = property.units.filter(u => u.leases.length > 0).length;
    const totalRent = property.units.reduce((sum, u) => {
        const lease = u.leases[0];
        return sum + (lease ? lease.coldRent + lease.utilityAdvance : 0);
    }, 0);

    async function handleDelete() {
        'use server';
        await deleteProperty(propertyId);
    }

    // Fetch cash flow, service provider costs, and warehouse documents
    const sb = getSupabaseAdmin();
    const [cashFlowData, spCosts, warehouseDocs] = await Promise.all([
        getPropertyCashFlow(propertyId),
        getServiceProviderCosts(propertyId, property.serviceProviders),
        sb
            ? sb
                  .schema('warehouse')
                  .from('documents')
                  .select('id, file_name, doc_type, file_size_bytes, mime_type, created_at')
                  .eq('org_id', orgId)
                  .order('created_at', { ascending: false })
            : Promise.resolve({ data: [] }),
    ]);
    const documents = (warehouseDocs.data ?? []).map((d: { id: string; file_name: string; doc_type: string | null; file_size_bytes: number; mime_type: string; created_at: string }) => ({
        id: d.id,
        name: d.file_name,
        type: d.doc_type ?? 'other',
        fileSize: d.file_size_bytes,
        mimeType: d.mime_type,
        createdAt: d.created_at,
    }));

    return (
        <main className="p-6">
            <div className="mb-6">
                <div className="flex items-center gap-4 mb-2">
                    <Link href="/dashboard/properties">
                        <Button variant="ghost" size="sm">
                            <ArrowLeft className="h-4 w-4 mr-2" />
                            Zurück
                        </Button>
                    </Link>
                </div>
                <div className="flex justify-between items-start">
                    <div>
                        <div className="flex items-center gap-3">
                            <h1 className="text-2xl font-bold">{property.name}</h1>
                            <Badge variant="outline">{property.type}</Badge>
                        </div>
                        <p className="text-muted-foreground">{property.address}, {property.zip} {property.city}</p>
                        {property.yearBuilt && <p className="text-sm text-muted-foreground">Baujahr: {property.yearBuilt}</p>}
                    </div>
                    <div className="flex gap-2">
                        <PropertyForm property={property}>
                            <Button variant="outline" size="sm">
                                <Edit className="h-4 w-4 mr-2" />
                                Bearbeiten
                            </Button>
                        </PropertyForm>
                        <form action={handleDelete}>
                            <Button variant="outline" size="sm" className="text-red-600 hover:text-red-700">
                                <Trash2 className="h-4 w-4" />
                            </Button>
                        </form>
                    </div>
                </div>
            </div>

            {/* Stats */}
            <div className="grid gap-4 md:grid-cols-5 mb-6">
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-muted-foreground">Einheiten</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{property.units.length}</div>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-muted-foreground">Vermietet</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{occupiedUnits}</div>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-muted-foreground">Gesamtfläche</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{totalSqm.toFixed(0)} m²</div>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-muted-foreground">Leerstand</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{property.units.length - occupiedUnits}</div>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-muted-foreground">Mieteinnahmen/mtl.</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{totalRent.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })}</div>
                    </CardContent>
                </Card>
            </div>

            {/* Units */}
            <Card>
                <CardHeader className="flex flex-row items-center justify-between">
                    <div>
                        <CardTitle>Einheiten</CardTitle>
                        <CardDescription>Alle Wohn- und Gewerbeeinheiten dieser Immobilie</CardDescription>
                    </div>
                    <UnitForm propertyId={propertyId}>
                        <Button size="sm">
                            <Plus className="h-4 w-4 mr-2" />
                            Neue Einheit
                        </Button>
                    </UnitForm>
                </CardHeader>
                <CardContent>
                    {property.units.length === 0 ? (
                        <div className="text-center py-8 text-muted-foreground">
                            <Home className="h-12 w-12 mx-auto mb-4 opacity-50" />
                            <p>Noch keine Einheiten</p>
                            <p className="text-sm">Fügen Sie Wohnungen oder Gewerbeeinheiten hinzu</p>
                        </div>
                    ) : (
                        <div className="space-y-3">
                            {property.units.map(unit => {
                                const lease = unit.leases[0];
                                return (
                                    <div key={unit.id} className="flex items-center justify-between p-4 border rounded-lg">
                                        <div className="flex items-center gap-4">
                                            <div className="p-2 bg-muted rounded-lg">
                                                <Home className="h-5 w-5" />
                                            </div>
                                            <div>
                                                <div className="flex items-center gap-2">
                                                    <span className="font-medium">{unit.unitNumber}</span>
                                                    {unit.floor !== null && (
                                                        <span className="text-sm text-muted-foreground">{unit.floor}. OG</span>
                                                    )}
                                                </div>
                                                <p className="text-sm text-muted-foreground">
                                                    {unit.sizeSqm} m² {unit.rooms && `• ${unit.rooms} Zimmer`}
                                                </p>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-4">
                                            {lease ? (
                                                <div className="text-right">
                                                    <div className="flex items-center gap-1">
                                                        <Users className="h-4 w-4" />
                                                        <span className="font-medium">
                                                            {lease.mainTenant.firstName} {lease.mainTenant.lastName}
                                                        </span>
                                                    </div>
                                                    <p className="text-sm text-muted-foreground">
                                                        {(lease.coldRent + lease.utilityAdvance).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })}/mtl.
                                                    </p>
                                                    <Badge variant="default" className="mt-1">Vermietet</Badge>
                                                </div>
                                            ) : (
                                                <div className="flex items-center gap-2">
                                                    <Badge variant="secondary">Leer</Badge>
                                                    {persons.length > 0 && (
                                                        <LeaseForm unitId={unit.id} propertyId={propertyId} persons={persons}>
                                                            <Button variant="outline" size="sm">
                                                                <UserPlus className="h-4 w-4 mr-1" />
                                                                Vermieten
                                                            </Button>
                                                        </LeaseForm>
                                                    )}
                                                </div>
                                            )}
                                            <UnitForm propertyId={propertyId} unit={unit}>
                                                <Button variant="ghost" size="sm">
                                                    <Edit className="h-4 w-4" />
                                                </Button>
                                            </UnitForm>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* No persons hint */}
            {
                persons.length === 0 && property.units.some(u => u.leases.length === 0) && (
                    <Card className="mt-6 border-dashed">
                        <CardContent className="py-6 text-center">
                            <Users className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
                            <p className="text-muted-foreground">
                                Um Einheiten zu vermieten, legen Sie zuerst{' '}
                                <Link href="/dashboard/rent-roll" className="text-primary hover:underline">
                                    Mieter an
                                </Link>
                                .
                            </p>
                        </CardContent>
                    </Card>
                )
            }

            {/* Service Providers */}
            <div className="mt-6">
                <ServiceProviderList
                    propertyId={propertyId}
                    providers={property.serviceProviders}
                    costs={spCosts}
                />
            </div>

            {/* Cash Flow */}
            <div className="mt-6">
                <PropertyCashFlow data={cashFlowData} />
            </div>

            {/* Documents */}
            <div className="mt-6">
                <DocumentList
                    propertyId={propertyId}
                    documents={documents}
                />
            </div>
        </main >
    );
}
