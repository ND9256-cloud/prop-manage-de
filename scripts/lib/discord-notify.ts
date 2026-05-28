// scripts/lib/discord-notify.ts
//
// Thin Discord webhook POST helper. Mirrors the shape of the off-repo
// discord-bridge.js used by synthetic monitoring on the Mac Mini: there is no
// shared library to import (that one lives at ~/scripts/discord-bridge.js,
// outside the repo, so a GitHub-Actions-hosted job cannot reach it). The
// "helper" pattern is a single fetch, factored here so call sites stay terse
// and a missing webhook URL is a silent no-op (CI without secrets, local
// dev runs) instead of a hard failure.
//
// Format-agnostic: callers compose their own content text. Keep it short and
// scannable per the synthetic-monitor convention.

export async function postDiscord(content: string): Promise<void> {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) {
    console.log("[discord] DISCORD_WEBHOOK_URL not set — skipping post");
    return;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[discord] webhook ${res.status}: ${body.slice(0, 200)}`);
    }
  } catch (err) {
    console.warn("[discord] webhook POST failed", err);
  }
}
