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

// Helper: send a Telegram reply message
async function sendTelegramReply(
    chatId: number,
    text: string,
    token: string
): Promise<void> {
    await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text }),
        }
    );
}

serve(async (req: Request) => {
    const ok = () =>
        new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });

    if (req.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
            status: 405,
            headers: { "Content-Type": "application/json" },
        });
    }

    const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
    let chatId = 0;

    // ─── STEP 0: Verify Telegram webhook secret ──────────────
    const telegramSecret = req.headers.get("x-telegram-bot-api-secret-token");
    const expectedSecret = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") || "";
    if (!expectedSecret || telegramSecret !== expectedSecret) {
        // Return 200 silently — do not reveal that verification failed
        return ok();
    }

    try {
        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        const supabase = createClient(supabaseUrl, supabaseKey);

        // ─── STEP 1: Parse update and verify allowed chat ────────
        const update = await req.json();
        const message = update?.message;

        if (!message) {
            console.log("Step 1: no message in update — ignoring");
            return ok();
        }

        chatId = message.chat?.id || 0;

        const allowedChatIdsRaw = Deno.env.get("ALLOWED_CHAT_IDS") || "";
        if (allowedChatIdsRaw.trim()) {
            const allowedChatIds = allowedChatIdsRaw
                .split(",")
                .map((s) => s.trim());

            if (!allowedChatIds.includes(String(chatId))) {
                console.log(`Step 1: chat ${chatId} not authorised`);
                await sendTelegramReply(chatId, "Not authorised", botToken);
                return ok();
            }
        }

        console.log(`Step 1: chat ${chatId} authorised (from: ${message.from?.first_name})`);

        // ─── STEP 2: Identify file ──────────────────────────────
        let fileId = "";
        let fileName = "";
        let mimeType = "";
        let fileSize = 0;

        if (message.document) {
            fileId = message.document.file_id;
            fileName = message.document.file_name || "document";
            mimeType = message.document.mime_type || "application/octet-stream";
            fileSize = message.document.file_size || 0;
            console.log(`Step 2: document "${fileName}" (${mimeType}, ${fileSize} bytes)`);
        } else if (message.photo && message.photo.length > 0) {
            // Use highest resolution (last in array)
            const photo = message.photo[message.photo.length - 1];
            fileId = photo.file_id;
            fileName = `photo_${Date.now()}.jpg`;
            mimeType = "image/jpeg";
            fileSize = photo.file_size || 0;
            console.log(`Step 2: photo ${photo.width}x${photo.height} (${fileSize} bytes)`);
        } else {
            console.log("Step 2: no document or photo — sending help message");
            await sendTelegramReply(
                chatId,
                "Please send a PDF or photo of a document",
                botToken
            );
            return ok();
        }

        // ─── STEP 3: Validate file ──────────────────────────────
        if (!ALLOWED_MIME_TYPES.has(mimeType)) {
            console.log(`Step 3: mime type ${mimeType} not allowed`);
            await sendTelegramReply(
                chatId,
                "File type not supported. Please send PDF, Word doc, or photo.",
                botToken
            );
            return ok();
        }

        if (fileSize > MAX_FILE_SIZE) {
            console.log(`Step 3: file too large (${fileSize} bytes)`);
            await sendTelegramReply(
                chatId,
                "File too large. Maximum size is 50MB.",
                botToken
            );
            return ok();
        }

        console.log("Step 3: file validated");

        // ─── STEP 4: Check idempotency by file_id ───────────────
        const { data: existingByRef } = await supabase
            .schema("warehouse")
            .from("documents")
            .select("id")
            .eq("source_ref", fileId)
            .limit(1);

        if (existingByRef && existingByRef.length > 0) {
            console.log(`Step 4: duplicate by source_ref (file_id: ${fileId})`);
            await sendTelegramReply(chatId, "Already received this file.", botToken);
            return ok();
        }

        console.log("Step 4: idempotency check passed");

        // ─── STEP 5: Look up org_id ─────────────────────────────
        const { data: org } = await supabase
            .schema("shared")
            .from("organisations")
            .select("id")
            .limit(1)
            .single();

        const orgId: string | null = org?.id || null;

        if (!orgId) {
            console.error("Step 5: no organisation found");
            await sendTelegramReply(
                chatId,
                "❌ Error: no organisation configured.",
                botToken
            );
            return ok();
        }

        console.log(`Step 5: org_id ${orgId}`);

        // ─── STEP 6: Download file from Telegram ─────────────────
        const getFileResponse = await fetch(
            `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`
        );
        const getFileResult = await getFileResponse.json();

        if (!getFileResult.ok || !getFileResult.result?.file_path) {
            console.error("Step 6: Telegram getFile failed:", JSON.stringify(getFileResult));
            await sendTelegramReply(
                chatId,
                "❌ Error downloading file from Telegram. Please try again.",
                botToken
            );
            return ok();
        }

        const filePath = getFileResult.result.file_path;
        const fileUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;

        const fileResponse = await fetch(fileUrl);
        if (!fileResponse.ok) {
            console.error(`Step 6: file download failed: HTTP ${fileResponse.status}`);
            await sendTelegramReply(
                chatId,
                "❌ Error downloading file. Please try again.",
                botToken
            );
            return ok();
        }

        const fileBuffer = await fileResponse.arrayBuffer();
        const fileBytes = new Uint8Array(fileBuffer);
        console.log(`Step 6: downloaded ${fileBytes.length} bytes from Telegram`);

        // ─── STEP 7: Compute hash and check duplicate ────────────
        const hashBuffer = await crypto.subtle.digest("SHA-256", fileBytes);
        const hashArray = new Uint8Array(hashBuffer);
        const fileHash = Array.from(hashArray)
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");

        const { data: existingByHash } = await supabase
            .schema("warehouse")
            .from("documents")
            .select("id")
            .eq("file_hash", fileHash)
            .eq("org_id", orgId)
            .limit(1);

        if (existingByHash && existingByHash.length > 0) {
            console.log(`Step 7: duplicate by hash (${fileHash.substring(0, 12)}...)`);
            await sendTelegramReply(chatId, "Already received this file.", botToken);
            return ok();
        }

        console.log(`Step 7: hash ${fileHash.substring(0, 12)}... is unique`);

        // ─── STEP 8: Upload to Supabase Storage ──────────────────
        const documentId = crypto.randomUUID();
        const sanitisedName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
        const storagePath = `${orgId}/${documentId}/${sanitisedName}`;

        const { error: uploadError } = await supabase.storage
            .from("property-documents")
            .upload(storagePath, fileBytes, {
                contentType: mimeType,
                upsert: false,
            });

        if (uploadError) {
            console.error(`Step 8: upload failed: ${uploadError.message}`);
            await sendTelegramReply(
                chatId,
                "❌ Error saving file. Please try again.",
                botToken
            );
            return ok();
        }

        console.log(`Step 8: uploaded to ${storagePath}`);

        // ─── STEP 9: Save to database ────────────────────────────
        const { error: docInsertError } = await supabase
            .schema("warehouse")
            .from("documents")
            .insert({
                id: documentId,
                org_id: orgId,
                source: "telegram",
                source_ref: fileId,
                file_name: sanitisedName,
                file_hash: fileHash,
                file_size_bytes: fileSize,
                mime_type: mimeType,
                storage_path: storagePath,
                status: "queued",
            });

        if (docInsertError) {
            console.error(`Step 9: document insert failed: ${docInsertError.message}`);
            await sendTelegramReply(
                chatId,
                "❌ Error saving file. Please try again.",
                botToken
            );
            return ok();
        }

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
            console.error(`Step 9: job insert failed: ${jobInsertError.message}`);
            // Non-fatal: document was created
        }

        console.log(`Step 9: document ${documentId} and job saved`);

        // ─── STEP 10: Send confirmation ──────────────────────────
        await sendTelegramReply(
            chatId,
            `✅ Received ${fileName}. Processing now...`,
            botToken
        );

        console.log(`Step 10: confirmation sent for ${fileName}`);

        return ok();
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : "Unknown error";
        console.error("Telegram bot error:", errMsg);

        // Try to notify user of the error
        if (chatId && botToken) {
            try {
                await sendTelegramReply(
                    chatId,
                    "❌ Error saving file. Please try again.",
                    botToken
                );
            } catch {
                console.error("Failed to send error reply to Telegram");
            }
        }

        return ok();
    }
});
