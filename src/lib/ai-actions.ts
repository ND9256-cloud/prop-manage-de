
'use server';

import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { processDocument } from '@/lib/document-processor';
import { answerQuestion, getSuggestedQuestions } from '@/lib/rag-chat';
import { supabase } from '@/lib/supabase';

// ---------------------------------------------------------------------------
// Server actions for AI features (authenticated, user-facing)
// ---------------------------------------------------------------------------

/**
 * Process a document for AI (extract text, create embeddings)
 */
export async function processDocumentForAI(documentId: string) {
    const session = await auth();
    if (!session?.user?.email) throw new Error('Not authenticated');

    const user = await prisma.user.findUnique({
        where: { email: session.user.email },
        select: { organizationId: true },
    });

    if (!user?.organizationId) throw new Error('User not in organization');

    const document = await prisma.document.findFirst({
        where: {
            id: documentId,
            organizationId: user.organizationId,
        },
    });

    if (!document) throw new Error('Document not found');

    const { data, error } = await supabase.storage
        .from('documents')
        .download(document.storagePath);

    if (error || !data) {
        throw new Error(`Failed to download document: ${error?.message}`);
    }

    const arrayBuffer = await data.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    return processDocument(documentId, buffer, document.mimeType);
}

/**
 * Ask a question about documents
 */
export async function askDocumentQuestion(
    question: string,
    propertyId?: string
): Promise<{ answer: string; sources: { documentName: string; documentId: string; content: string }[] }> {
    const session = await auth();
    if (!session?.user?.email) throw new Error('Not authenticated');

    const user = await prisma.user.findUnique({
        where: { email: session.user.email },
        select: { organizationId: true },
    });

    if (!user?.organizationId) throw new Error('User not in organization');

    return answerQuestion(question, user.organizationId, propertyId);
}

/**
 * Get suggested questions for a property
 */
export async function getPropertySuggestedQuestions(propertyId?: string): Promise<string[]> {
    const session = await auth();
    if (!session?.user?.email) return [];

    const user = await prisma.user.findUnique({
        where: { email: session.user.email },
        select: { organizationId: true },
    });

    if (!user?.organizationId) return [];

    return getSuggestedQuestions(user.organizationId, propertyId);
}

/**
 * Check if a document has been processed for AI
 */
export async function getDocumentAIStatus(documentId: string): Promise<{
    isProcessed: boolean;
    chunkCount: number;
}> {
    const session = await auth();
    if (!session?.user?.email) throw new Error('Not authenticated');

    const chunkCount = await prisma.documentChunk.count({
        where: { documentId },
    });

    return {
        isProcessed: chunkCount > 0,
        chunkCount,
    };
}
