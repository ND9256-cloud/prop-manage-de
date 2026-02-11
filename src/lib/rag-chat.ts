
import { prisma } from '@/lib/db';
import { chatWithContext } from '@/lib/ai';
import { searchDocumentChunks } from '@/lib/document-processor';

export interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
    sources?: { documentName: string; documentId: string }[];
    timestamp: Date;
}

/**
 * Answer a question using RAG (Retrieval-Augmented Generation)
 */
export async function answerQuestion(
    question: string,
    organizationId: string,
    propertyId?: string
): Promise<{ answer: string; sources: { documentName: string; documentId: string; content: string }[] }> {
    // Search for relevant document chunks
    const relevantChunks = await searchDocumentChunks(
        question,
        organizationId,
        propertyId,
        5 // Get top 5 most relevant chunks
    );

    if (relevantChunks.length === 0) {
        return {
            answer: 'Ich habe keine relevanten Dokumente gefunden, die diese Frage beantworten könnten. Bitte laden Sie zunächst relevante Dokumente hoch.',
            sources: [],
        };
    }

    // Prepare context for the AI
    const context = relevantChunks.map(chunk => ({
        content: chunk.content,
        documentName: chunk.documentName,
    }));

    // Get answer from Gemini with context
    const systemPrompt = `Du bist ein hilfreicher Assistent für ein deutsches Immobilienverwaltungssystem. 
Beantworte Fragen basierend auf den bereitgestellten Dokumenten. 
Zitiere immer deine Quellen, wenn du Informationen aus den Dokumenten verwendest.
Wenn die Information nicht in den Dokumenten zu finden ist, sage das ehrlich.
Antworte auf Deutsch, es sei denn, der Nutzer fragt auf Englisch.`;

    const answer = await chatWithContext(question, context, systemPrompt);

    // Dedupe sources
    const uniqueSources = relevantChunks.reduce((acc, chunk) => {
        if (!acc.find(s => s.documentId === chunk.documentId)) {
            acc.push({
                documentName: chunk.documentName,
                documentId: chunk.documentId,
                content: chunk.content.substring(0, 200) + '...',
            });
        }
        return acc;
    }, [] as { documentName: string; documentId: string; content: string }[]);

    return {
        answer,
        sources: uniqueSources,
    };
}

/**
 * Get suggested questions based on the documents
 */
export async function getSuggestedQuestions(
    organizationId: string,
    propertyId?: string
): Promise<string[]> {
    // Get a sample of documents to suggest questions
    const documents = await prisma.document.findMany({
        where: {
            organizationId,
            ...(propertyId ? { propertyId } : {}),
            chunks: { some: {} }, // Only documents with chunks
        },
        take: 5,
        select: { name: true, type: true },
    });

    if (documents.length === 0) {
        return [
            'Laden Sie Dokumente hoch, um Fragen stellen zu können.',
        ];
    }

    // Suggest questions based on document types
    const suggestions: string[] = [];

    const hasContract = documents.some(d =>
        d.type?.toLowerCase().includes('vertrag') ||
        d.type?.toLowerCase().includes('contract') ||
        d.name.toLowerCase().includes('mietvertrag')
    );

    const hasInvoice = documents.some(d =>
        d.type?.toLowerCase().includes('rechnung') ||
        d.type?.toLowerCase().includes('invoice')
    );

    if (hasContract) {
        suggestions.push('Was ist die Kündigungsfrist?');
        suggestions.push('Wie hoch ist die Kaution?');
    }

    if (hasInvoice) {
        suggestions.push('Wie hoch sind die Gesamtkosten?');
        suggestions.push('Was sind die größten Kostenpunkte?');
    }

    suggestions.push(`Was steht in ${documents[0]?.name}?`);

    return suggestions.slice(0, 4);
}
