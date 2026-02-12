import { GoogleGenerativeAI } from '@google/generative-ai';

const SYSTEM_PROMPT = `Du bist ein Experte für deutsche Immobilienverwaltung. Analysiere den folgenden Dokumenttext und extrahiere Informationen über den Dienstleister/Versorger.

Antworte NUR mit gültigem JSON in diesem Format (keine Erklärungen):
{
  "found": true/false,
  "name": "Name des Versorgers/Dienstleisters",
  "category": "strom|gas|wasser|heizung|versicherung|grundbesitzabgaben|hausverwaltung|wartung|sonstige",
  "contractNumber": "Vertragsnummer oder null",
  "monthlyCost": Zahl oder null (monatliche Kosten in EUR),
  "yearlyCost": Zahl oder null (jährliche Kosten in EUR),
  "contactName": "Ansprechpartner oder null",
  "contactPhone": "Telefonnummer oder null",
  "contactEmail": "E-Mail oder null"
}

Regeln:
- "found" ist true wenn das Dokument Infos über einen Versorger/Dienstleister enthält
- Konvertiere IMMER in EUR. 
- Bei jährlicher Angabe: yearlyCost setzen, monthlyCost = yearlyCost / 12
- Bei monatlicher Angabe: monthlyCost setzen, yearlyCost = monthlyCost * 12
- Erkenne: Strom, Gas, Wasser, Heizung, Versicherung (Gebäude-, Haftpflicht-, etc.), Grundbesitzabgaben/Grundsteuer, Hausverwaltung, Wartung (Aufzug, Heizung, etc.)
- Wenn kein Dienstleister erkannt wird: {"found": false}`;

export interface ExtractedProvider {
    found: boolean;
    name?: string;
    category?: string;
    contractNumber?: string | null;
    monthlyCost?: number | null;
    yearlyCost?: number | null;
    contactName?: string | null;
    contactPhone?: string | null;
    contactEmail?: string | null;
}

export async function extractServiceProvider(
    documentText: string,
): Promise<ExtractedProvider> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.warn('GEMINI_API_KEY not set — skipping extraction');
        return { found: false };
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
        model: 'gemini-2.0-flash',
        generationConfig: {
            temperature: 0,
            responseMimeType: 'application/json',
        },
    });

    try {
        const result = await model.generateContent([
            { text: SYSTEM_PROMPT },
            { text: documentText.slice(0, 8000) },
        ]);

        const content = result.response.text();
        if (!content) return { found: false };

        const parsed = JSON.parse(content) as ExtractedProvider;
        return parsed;
    } catch (err) {
        console.error('AI extraction failed:', err);
        return { found: false };
    }
}

export async function extractTextFromPdf(buffer: ArrayBuffer): Promise<string> {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const pdfParse = require('pdf-parse');
        const result = await pdfParse(Buffer.from(buffer));
        return result.text;
    } catch (err) {
        console.error('PDF parse failed:', err);
        return '';
    }
}
