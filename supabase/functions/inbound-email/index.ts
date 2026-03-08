import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const ALLOWED_MIME_TYPES = new Set([
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/heic",
    "image/webp",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

const MAX_FILE_SIZE = 52428800; // 50MB

interface PostmarkAttachment {
    Name: string;
    Content: string; // base64
    ContentType: string;
    ContentLength: number;
}

interface PostmarkPayload {
    MessageID: string;
    From: string;
    Subject: string;
    TextBody: string;
    Attachments: PostmarkAttachment[];
}

serve(async (req: Request) => {
    // Always return 200 to Postmark — never trigger retry loops
    const ok = (body: Record<string, unknown>) =>
        new Response(JSON.stringify(body), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });

    if (req.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
            status: 405,
            headers: { "Content-Type": "application/json" },
        });
    }

    try {
        // ─── STEP 1: Verify webhook secret token ─────────────────
        // Postmark webhook URL should be configured as:
        //   https://project.supabase.co/functions/v1/inbound-email?token=SECRET
        const url = new URL(req.url);
        const token = url.searchParams.get("token") || "";
        const expectedToken = Deno.env.get("POSTMARK_WEBHOOK_SECRET") || "";

        if (!expectedToken || token !== expectedToken) {
            // Return 200 silently — never reveal endpoint exists or that auth failed
            console.log("Step 1: webhook token invalid — silently dropping");
            return ok({ message: "received" });
        }

        console.log("Step 1: webhook token verified");

        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        const supabase = createClient(supabaseUrl, supabaseKey);

        // ─── STEP 2: Parse Postmark payload ─────────────────────
        const payload: PostmarkPayload = await req.json();
        const { MessageID, From, Attachments } = payload;

        console.log(`Step 2: received email from ${From} (MessageID: ${MessageID})`);

        if (!Attachments || Attachments.length === 0) {
            console.log("Step 2: no attachments — done");
            return ok({ message: "no attachments", message_id: MessageID });
        }

        console.log(`Step 2: ${Attachments.length} attachment(s) found`);

        // ─── STEP 3: Validate sender ────────────────────────────
        const allowedSendersRaw = Deno.env.get("ALLOWED_EMAIL_SENDERS") || "";
        if (allowedSendersRaw.trim()) {
            const allowedSenders = allowedSendersRaw
                .split(",")
                .map((s) => s.trim().toLowerCase());

            const senderLower = From.toLowerCase();
            const isAllowed = allowedSenders.some(
                (allowed) => senderLower.includes(allowed)
            );

            if (!isAllowed) {
                // Silently drop — never tell spammers they're blocked
                console.log(`Step 3: sender ${From} not in allowlist — silently dropping`);
                return ok({ message: "received", message_id: MessageID });
            }
        }

        console.log("Step 3: sender validated");

        // ─── STEP 4: Look up org_id ─────────────────────────────
        let orgId: string | null = null;

        // Try to find user by email
        const fromEmail = From.includes("<")
            ? From.match(/<([^>]+)>/)?.[1] || From
            : From;

        const { data: user } = await supabase
            .schema("shared")
            .from("users")
            .select("org_id")
            .eq("email", fromEmail.toLowerCase())
            .single();

        if (user?.org_id) {
            orgId = user.org_id;
            console.log(`Step 4: found org_id ${orgId} from user email`);
        } else {
            // Fallback: single-tenant — use first organisation
            const { data: org } = await supabase
                .schema("shared")
                .from("organisations")
                .select("id")
                .limit(1)
                .single();

            orgId = org?.id || null;

            if (orgId) {
                console.log(`Step 4: using fallback org_id ${orgId}`);
            } else {
                console.error("Step 4: no organisation found — cannot process");
                return ok({ error: "no organisation", message_id: MessageID });
            }
        }

        // ─── STEP 4b: Rate limit check ──────────────────────────
        // Max 20 uploads per sender per hour, max 50 per org per hour
        const { data: isAllowedRate } = await supabase.rpc("check_rate_limit", {
            p_sender: fromEmail.toLowerCase(),
            p_org_id: orgId,
            p_max_per_sender: 20,
            p_max_per_org: 50,
        });

        if (isAllowedRate === false) {
            console.log(`Step 4b: rate limit exceeded for ${fromEmail} / org ${orgId} — silently dropping`);
            return ok({ message: "received", message_id: MessageID });
        }

        console.log("Step 4b: rate limit check passed");

        // ─── STEP 5: Process each attachment ─────────────────────
        let processed = 0;
        let skipped = 0;

        for (const attachment of Attachments) {
            const { Name, Content, ContentType, ContentLength } = attachment;

            // 5a. Check ContentType allowlist
            if (!ALLOWED_MIME_TYPES.has(ContentType)) {
                console.log(`Step 5: skipping "${Name}" — mime type ${ContentType} not allowed`);
                skipped++;
                continue;
            }

            // 5b. Check size
            if (ContentLength > MAX_FILE_SIZE) {
                console.log(`Step 5: skipping "${Name}" — ${ContentLength} bytes exceeds 50MB limit`);
                skipped++;
                continue;
            }

            // 5c. Decode base64 to bytes
            const binaryString = atob(Content);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }

            // 5d. Compute SHA-256 hash
            const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
            const hashArray = new Uint8Array(hashBuffer);
            const fileHash = Array.from(hashArray)
                .map((b) => b.toString(16).padStart(2, "0"))
                .join("");

            // 5e. Check for duplicate
            const { data: existing } = await supabase
                .schema("warehouse")
                .from("documents")
                .select("id")
                .eq("file_hash", fileHash)
                .eq("org_id", orgId)
                .limit(1);

            if (existing && existing.length > 0) {
                console.log(`Step 5: skipping "${Name}" — duplicate (hash: ${fileHash.substring(0, 12)}...)`);
                skipped++;
                continue;
            }

            // 5f. Generate document UUID
            const documentId = crypto.randomUUID();

            // 5g. Upload to Supabase Storage
            const sanitisedName = Name.replace(/[^a-zA-Z0-9._-]/g, "_");
            const storagePath = `${orgId}/${documentId}/${sanitisedName}`;

            const { error: uploadError } = await supabase.storage
                .from("property-documents")
                .upload(storagePath, bytes, {
                    contentType: ContentType,
                    upsert: false,
                });

            if (uploadError) {
                console.error(`Step 5: upload failed for "${Name}": ${uploadError.message}`);
                skipped++;
                continue;
            }

            // 5h. INSERT warehouse.documents
            const { error: docInsertError } = await supabase
                .schema("warehouse")
                .from("documents")
                .insert({
                    id: documentId,
                    org_id: orgId,
                    source: "email",
                    source_ref: MessageID,
                    file_name: Name,
                    file_hash: fileHash,
                    file_size_bytes: ContentLength,
                    mime_type: ContentType,
                    storage_path: storagePath,
                    status: "queued",
                });

            if (docInsertError) {
                console.error(`Step 5: document insert failed for "${Name}": ${docInsertError.message}`);
                skipped++;
                continue;
            }

            // 5i. INSERT warehouse.processing_jobs
            const { error: jobInsertError } = await supabase
                .schema("warehouse")
                .from("processing_jobs")
                .insert({
                    document_id: documentId,
                    org_id: orgId,
                    status: "queued",
                    next_attempt_at: new Date().toISOString(),
                });

            if (jobInsertError) {
                console.error(`Step 5: job insert failed for "${Name}": ${jobInsertError.message}`);
                // Document was created but job wasn't — still count as processed
            }

            processed++;
            console.log(`Step 5: processed "${Name}" → document ${documentId}`);
        }

        // ─── STEP 6: Return response ─────────────────────────────
        console.log(
            `Step 6: done — processed: ${processed}, skipped: ${skipped}`
        );

        return ok({
            processed,
            skipped,
            message_id: MessageID,
        });
    } catch (err) {
        // Always return 200 to Postmark — never trigger retry loops
        const errMsg = err instanceof Error ? err.message : "Unknown error";
        console.error("Inbound email error:", errMsg);
        return ok({ error: errMsg });
    }
});
