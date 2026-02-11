
import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Building2, Plus, MapPin, Home, FileText, Users } from 'lucide-react';
import PropertyForm from '@/components/properties/property-form';

export default async function PropertiesPage() {
    const session = await auth();
    if (!session?.user?.email) {
        notFound();
    }

    const user = await prisma.user.findUnique({
        where: { email: session.user.email },
        select: { organizationId: true },
    });

    if (!user?.organizationId) {
        notFound();
    }

    const properties = await prisma.property.findMany({
        where: { organizationId: user.organizationId },
        include: {
            _count: { select: { units: true, documents: true } },
            units: {
                include: {
                    leases: {
                        where: { status: 'ACTIVE' },
                        select: { id: true },
                    },
                },
            },
        },
        orderBy: { createdAt: 'desc' },
    });

    // Calculate stats
    const totalUnits = properties.reduce((sum, p) => sum + p._count.units, 0);
    const occupiedUnits = properties.reduce((sum, p) =>
        sum + p.units.filter(u => u.leases.length > 0).length, 0
    );
    const occupancyRate = totalUnits > 0 ? Math.round((occupiedUnits / totalUnits) * 100) : 0;

    return (
        <main className="p-6">
            <div className="flex justify-between items-center mb-6">
                <div>
                    <h1 className="text-2xl font-bold">Immobilien</h1>
                    <p className="text-muted-foreground">Verwalten Sie Ihre Immobilien und Einheiten</p>
                </div>
                <PropertyForm>
                    <Button>
                        <Plus className="h-4 w-4 mr-2" />
                        Neue Immobilie
                    </Button>
                </PropertyForm>
            </div>

            {/* Stats */}
            <div className="grid gap-4 md:grid-cols-4 mb-6">
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-muted-foreground">Immobilien</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{properties.length}</div>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-muted-foreground">Einheiten</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{totalUnits}</div>
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
                        <CardTitle className="text-sm font-medium text-muted-foreground">Auslastung</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{occupancyRate}%</div>
                    </CardContent>
                </Card>
            </div>

            {/* Property List */}
            {properties.length === 0 ? (
                <Card>
                    <CardContent className="py-12 text-center">
                        <Building2 className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
                        <h3 className="text-lg font-semibold mb-2">Noch keine Immobilien</h3>
                        <p className="text-muted-foreground mb-4">Fügen Sie Ihre erste Immobilie hinzu, um zu beginnen.</p>
                        <PropertyForm>
                            <Button>
                                <Plus className="h-4 w-4 mr-2" />
                                Erste Immobilie erstellen
                            </Button>
                        </PropertyForm>
                    </CardContent>
                </Card>
            ) : (
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {properties.map(property => {
                        const propertyOccupied = property.units.filter(u => u.leases.length > 0).length;
                        const propertyOccupancy = property._count.units > 0
                            ? Math.round((propertyOccupied / property._count.units) * 100)
                            : 0;

                        return (
                            <Card key={property.id} className="hover:shadow-md transition-shadow">
                                <CardHeader>
                                    <div className="flex justify-between items-start">
                                        <div>
                                            <CardTitle className="text-lg">{property.name}</CardTitle>
                                            <CardDescription className="flex items-center gap-1 mt-1">
                                                <MapPin className="h-3 w-3" />
                                                {property.address}, {property.zip} {property.city}
                                            </CardDescription>
                                        </div>
                                        <Badge variant="outline">{property.type}</Badge>
                                    </div>
                                </CardHeader>
                                <CardContent>
                                    <div className="flex items-center gap-4 text-sm text-muted-foreground mb-4">
                                        <span className="flex items-center gap-1">
                                            <Home className="h-4 w-4" />
                                            {property._count.units} Einheiten
                                        </span>
                                        <span className="flex items-center gap-1">
                                            <Users className="h-4 w-4" />
                                            {propertyOccupancy}% belegt
                                        </span>
                                        <span className="flex items-center gap-1">
                                            <FileText className="h-4 w-4" />
                                            {property._count.documents}
                                        </span>
                                    </div>
                                    <div className="flex gap-2">
                                        <Link href={`/dashboard/properties/${property.id}`} className="flex-1">
                                            <Button variant="outline" className="w-full" size="sm">
                                                Details
                                            </Button>
                                        </Link>
                                        <Link href={`/dashboard/properties/${property.id}/documents`}>
                                            <Button variant="ghost" size="sm">
                                                <FileText className="h-4 w-4" />
                                            </Button>
                                        </Link>

                                    </div>
                                </CardContent>
                            </Card>
                        );
                    })}
                </div>
            )}
        </main>
    );
}
