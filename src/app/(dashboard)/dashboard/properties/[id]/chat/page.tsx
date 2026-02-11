
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import DocumentChatWrapper from '@/components/documents/document-chat-wrapper';
import { askDocumentQuestion, getPropertySuggestedQuestions } from '@/lib/ai-actions';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { ArrowLeft, FileText } from 'lucide-react';

interface PageProps {
    params: Promise<{ id: string }>;
}

export default async function PropertyChatPage({ params }: PageProps) {
    const { id: propertyId } = await params;

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

    // Get property
    const property = await prisma.property.findFirst({
        where: {
            id: propertyId,
            organizationId: user.organizationId,
        },
    });

    if (!property) {
        notFound();
    }

    // Get suggested questions
    const suggestedQuestions = await getPropertySuggestedQuestions(propertyId);

    // Check how many documents are processed
    const processedDocs = await prisma.document.count({
        where: {
            propertyId,
            organizationId: user.organizationId,
            chunks: { some: {} },
        },
    });

    const totalDocs = await prisma.document.count({
        where: {
            propertyId,
            organizationId: user.organizationId,
        },
    });

    // Server action wrapper
    async function handleAskQuestion(question: string) {
        'use server';
        return await askDocumentQuestion(question, propertyId);
    }

    return (
        <main className="p-6">
            <div className="mb-6">
                <div className="flex items-center gap-4 mb-2">
                    <Link href={`/dashboard/properties/${propertyId}/documents`}>
                        <Button variant="ghost" size="sm">
                            <ArrowLeft className="h-4 w-4 mr-2" />
                            Zurück zu Dokumenten
                        </Button>
                    </Link>
                </div>
                <h1 className="text-2xl font-bold">{property.name} - KI-Assistent</h1>
                <p className="text-muted-foreground">{property.address}, {property.zip} {property.city}</p>
                <div className="flex items-center gap-2 mt-2 text-sm">
                    <FileText className="h-4 w-4" />
                    <span>{processedDocs} von {totalDocs} Dokumenten für KI verarbeitet</span>
                </div>
            </div>

            <div className="max-w-3xl">
                <DocumentChatWrapper
                    propertyId={propertyId}
                    propertyName={property.name}
                    suggestedQuestions={suggestedQuestions}
                    onAskQuestion={handleAskQuestion}
                />
            </div>
        </main>
    );
}
