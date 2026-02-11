
import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';

const apiKey = process.env.GOOGLE_AI_API_KEY;

if (!apiKey) {
    console.warn('GOOGLE_AI_API_KEY not set. AI features will be disabled.');
}

const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;

// Models
const embeddingModel = genAI?.getGenerativeModel({ model: 'gemini-embedding-001' });
const chatModel = genAI?.getGenerativeModel({ model: 'gemini-2.0-flash' });

/**
 * Retry helper with exponential backoff for rate limit errors
 */
export async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3, baseDelay = 5000): Promise<T> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error: any) {
            const isRateLimit = error?.status === 429 || error?.message?.includes('429') || error?.message?.includes('Too Many Requests');
            if (!isRateLimit || attempt === maxRetries) throw error;
            const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 2000;
            console.log(`[AI] Rate limited, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${maxRetries})...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    throw new Error('Unreachable');
}

/**
 * Generate embeddings for text using Gemini
 * @param text - Text to embed
 * @returns 768-dimensional embedding vector
 */
export async function generateEmbedding(text: string): Promise<number[]> {
    if (!embeddingModel) {
        throw new Error('Gemini API key not configured');
    }

    const result = await embeddingModel.embedContent(text);
    return result.embedding.values;
}


/**
 * Chat with context (RAG) using Gemini
 * @param question - User's question
 * @param context - Relevant document chunks as context
 * @param systemPrompt - Optional system prompt
 * @returns AI-generated answer
 */
export async function chatWithContext(
    question: string,
    context: { content: string; documentName: string; pageNumber?: number }[],
    systemPrompt?: string
): Promise<string> {
    if (!chatModel) {
        throw new Error('Gemini API key not configured');
    }

    // Build context string
    const contextString = context
        .map((c, i) => {
            const source = c.pageNumber
                ? `[Source ${i + 1}: ${c.documentName}, Page ${c.pageNumber}]`
                : `[Source ${i + 1}: ${c.documentName}]`;
            return `${source}\n${c.content}`;
        })
        .join('\n\n---\n\n');

    const prompt = `${systemPrompt || 'You are a helpful assistant for a property management system. Answer questions based on the provided documents. Always cite your sources when possible. If the information is not in the documents, say so.'}

Here are relevant excerpts from the user's documents:

${contextString}

---

User Question: ${question}

Please provide a helpful, accurate answer based on the documents above. Cite specific sources when referencing information.`;

    const result = await chatModel.generateContent(prompt);
    const response = await result.response;
    return response.text();
}

/**
 * Extract text from a document using Gemini Vision (for images/scans)
 * @param base64Data - Base64 encoded image data
 * @param mimeType - MIME type of the image
 * @returns Extracted text
 */
export async function extractTextFromImage(
    base64Data: string,
    mimeType: string
): Promise<string> {
    if (!chatModel) {
        throw new Error('Gemini API key not configured');
    }

    return withRetry(async () => {
        const result = await chatModel.generateContent([
            {
                inlineData: {
                    data: base64Data,
                    mimeType,
                },
            },
            'Extract all text from this image. Preserve the structure as much as possible. Return only the extracted text, no commentary.',
        ]);

        const response = await result.response;
        return response.text();
    });
}


export { genAI, embeddingModel, chatModel };
