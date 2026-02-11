
import { prisma } from '@/lib/db';
import { generateEmbedding, extractTextFromImage } from '@/lib/ai';

const CHUNK_SIZE = 500; // Target chunk size in characters
const CHUNK_OVERLAP = 50; // Overlap between chunks

/**
 * Split text into overlapping chunks for embedding
 */
export function splitIntoChunks(text: string, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
    const chunks: string[] = [];

    // Split by paragraphs first
    const paragraphs = text.split(/\n\n+/);
    let currentChunk = '';

    for (const paragraph of paragraphs) {
        if ((currentChunk + paragraph).length < chunkSize) {
            currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
        } else {
            if (currentChunk) {
                chunks.push(currentChunk);
            }
            // If paragraph is too long, split it further
            if (paragraph.length > chunkSize) {
                const words = paragraph.split(' ');
                currentChunk = '';
                for (const word of words) {
                    if ((currentChunk + ' ' + word).length < chunkSize) {
                        currentChunk += (currentChunk ? ' ' : '') + word;
                    } else {
                        if (currentChunk) chunks.push(currentChunk);
                        currentChunk = word;
                    }
                }
            } else {
                currentChunk = paragraph;
            }
        }
    }

    if (currentChunk) {
        chunks.push(currentChunk);
    }

    return chunks.filter(c => c.trim().length > 20); // Filter out tiny chunks
}

/**
 * Extract text from a PDF file using Gemini Vision
 * Works in serverless environment and handles scanned PDFs with OCR
 */
export async function extractTextFromPDF(buffer: Buffer): Promise<{ text: string; pageTexts: string[] }> {
    // Use Gemini Vision to extract text from PDF
    const base64 = buffer.toString('base64');

    const text = await extractTextFromImage(base64, 'application/pdf');

    return {
        text,
        pageTexts: [text], // Simplified - Gemini processes the whole PDF
    };
}

/**
 * Process a document: extract text, chunk it, generate embeddings, store in DB
 */
export async function processDocument(
    documentId: string,
    fileBuffer: Buffer,
    mimeType: string
): Promise<{ chunksCreated: number }> {
    // Get document info
    const document = await prisma.document.findUnique({
        where: { id: documentId },
        select: { id: true, name: true, organizationId: true },
    });

    if (!document) {
        throw new Error('Document not found');
    }

    let text = '';

    // Extract text based on file type
    if (mimeType === 'application/pdf') {
        const { text: pdfText } = await extractTextFromPDF(fileBuffer);
        text = pdfText;
    } else if (mimeType.startsWith('image/')) {
        // Use Gemini to extract text from images
        const base64 = fileBuffer.toString('base64');
        text = await extractTextFromImage(base64, mimeType);
    } else if (mimeType === 'text/plain' || mimeType === 'text/markdown') {
        text = fileBuffer.toString('utf-8');
    } else {
        // For other types, try to read as text
        try {
            text = fileBuffer.toString('utf-8');
        } catch {
            throw new Error(`Unsupported file type: ${mimeType}`);
        }
    }

    if (!text || text.trim().length === 0) {
        return { chunksCreated: 0 };
    }

    // Split into chunks
    const chunks = splitIntoChunks(text);

    // Delete existing chunks for this document (in case of re-processing)
    await prisma.documentChunk.deleteMany({
        where: { documentId },
    });

    // Process chunks in batches to avoid rate limits
    const BATCH_SIZE = 5;
    let chunksCreated = 0;

    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
        const batch = chunks.slice(i, i + BATCH_SIZE);

        // Generate embeddings for batch
        const embeddings = await Promise.all(
            batch.map(chunk => generateEmbedding(chunk))
        );

        // Store chunks with embeddings using raw SQL (for vector type)
        for (let j = 0; j < batch.length; j++) {
            const chunkIndex = i + j;
            // Sanitize content: remove null bytes and invalid UTF-8 characters
            const content = batch[j].replace(/\x00/g, '').replace(/[\uFFFD]/g, '');
            const embedding = embeddings[j];

            // Format embedding as PostgreSQL vector string: [n1,n2,...] -> '[n1,n2,...]'
            const embeddingStr = `[${embedding.join(',')}]`;

            // Use raw SQL to insert with vector type
            await prisma.$executeRaw`
        INSERT INTO "DocumentChunk" (id, "documentId", content, "chunkIndex", embedding, "organizationId", "createdAt")
        VALUES (
          gen_random_uuid(),
          ${documentId},
          ${content},
          ${chunkIndex},
          ${embeddingStr}::vector,
          ${document.organizationId},
          NOW()
        )
      `;

            chunksCreated++;
        }
    }

    return { chunksCreated };
}

/**
 * Search for relevant chunks using semantic similarity
 */
export async function searchDocumentChunks(
    query: string,
    organizationId: string,
    propertyId?: string,
    limit = 5
): Promise<{ id: string; content: string; documentId: string; documentName: string; similarity: number }[]> {
    // Generate embedding for the query
    const queryEmbedding = await generateEmbedding(query);
    const embeddingStr = `[${queryEmbedding.join(',')}]`;

    // Search using cosine similarity
    // Note: Lower distance = more similar for cosine distance
    let results;

    if (propertyId) {
        results = await prisma.$queryRawUnsafe<
            { id: string; content: string; documentId: string; documentName: string; similarity: number }[]
        >(`
            SELECT 
              dc.id,
              dc.content,
              dc."documentId",
              d.name as "documentName",
              1 - (dc.embedding <=> '${embeddingStr}'::vector) as similarity
            FROM "DocumentChunk" dc
            JOIN "Document" d ON dc."documentId" = d.id
            WHERE dc."organizationId" = $1
            AND d."propertyId" = $2
            AND dc.embedding IS NOT NULL
            ORDER BY dc.embedding <=> '${embeddingStr}'::vector
            LIMIT $3
        `, organizationId, propertyId, limit);
    } else {
        results = await prisma.$queryRawUnsafe<
            { id: string; content: string; documentId: string; documentName: string; similarity: number }[]
        >(`
            SELECT 
              dc.id,
              dc.content,
              dc."documentId",
              d.name as "documentName",
              1 - (dc.embedding <=> '${embeddingStr}'::vector) as similarity
            FROM "DocumentChunk" dc
            JOIN "Document" d ON dc."documentId" = d.id
            WHERE dc."organizationId" = $1
            AND dc.embedding IS NOT NULL
            ORDER BY dc.embedding <=> '${embeddingStr}'::vector
            LIMIT $2
        `, organizationId, limit);
    }

    return results;
}
