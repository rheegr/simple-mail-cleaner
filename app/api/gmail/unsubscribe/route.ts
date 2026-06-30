import { auth } from "@/auth";
import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.accessToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { senderEmail } = await req.json();
  if (!senderEmail) {
    return NextResponse.json({ error: "Missing senderEmail" }, { status: 400 });
  }

  const oauth2 = new google.auth.OAuth2();
  oauth2.setCredentials({ access_token: session.accessToken });
  const gmail = google.gmail({ version: "v1", auth: oauth2 });

  try {
    // Find a recent message from this sender to extract unsubscribe link
    const listRes = await gmail.users.messages.list({
      userId: "me",
      q: `from:${senderEmail}`,
      maxResults: 1,
      fields: "messages/id",
    });

    const msgId = listRes.data.messages?.[0]?.id;
    if (!msgId) {
      return NextResponse.json({ error: "No messages found from this sender" }, { status: 404 });
    }

    const msgRes = await gmail.users.messages.get({
      userId: "me",
      id: msgId,
      format: "METADATA",
      metadataHeaders: ["List-Unsubscribe", "List-Unsubscribe-Post"],
    });

    const headers = msgRes.data.payload?.headers ?? [];
    const raw = headers.find((h) => h.name === "List-Unsubscribe")?.value ?? "";
    const isOneClick = headers.some((h) => h.name === "List-Unsubscribe-Post");

    // Extract URLs and mailto
    const urls = [...raw.matchAll(/<(https?:\/\/[^>]+)>/g)].map((m) => m[1]);
    const mailtos = [...raw.matchAll(/<(mailto:[^>]+)>/g)].map((m) => m[1]);

    if (urls.length === 0 && mailtos.length === 0) {
      return NextResponse.json({ unsubscribed: false, reason: "No unsubscribe link found" });
    }

    let unsubscribed = false;

    // Try one-click POST first (RFC 8058)
    if (isOneClick && urls.length > 0) {
      try {
        const res = await fetch(urls[0], {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "List-Unsubscribe=One-Click",
        });
        unsubscribed = res.ok;
      } catch {
        // fall through to URL return
      }
    }

    return NextResponse.json({
      unsubscribed,
      unsubscribeUrl: urls[0] ?? null,
      mailtoUrl: mailtos[0] ?? null,
      isOneClick,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Gmail API error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
