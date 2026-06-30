import { auth } from "@/auth";
import { NextResponse } from "next/server";
import { google } from "googleapis";

export async function GET() {
  const session = await auth();
  if (!session?.accessToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const oauth2 = new google.auth.OAuth2();
  oauth2.setCredentials({ access_token: session.accessToken });
  const gmail = google.gmail({ version: "v1", auth: oauth2 });

  try {
    // Fetch up to 500 messages with metadata only
    const senderMap = new Map<
      string,
      { email: string; name: string; count: number; latestDate: string; sampleSubject: string }
    >();

    let pageToken: string | undefined;
    let fetched = 0;
    const maxFetch = 500;

    do {
      const listRes = await gmail.users.messages.list({
        userId: "me",
        maxResults: 100,
        pageToken,
        labelIds: ["INBOX"],
        fields: "messages/id,nextPageToken",
      });

      const messages = listRes.data.messages ?? [];
      pageToken = listRes.data.nextPageToken ?? undefined;

      // Batch fetch metadata
      const batchPromises = messages.map((m) =>
        gmail.users.messages.get({
          userId: "me",
          id: m.id!,
          format: "METADATA",
          metadataHeaders: ["From", "Date", "Subject"],
          fields: "id,payload/headers,internalDate",
        })
      );

      const results = await Promise.all(batchPromises);

      for (const res of results) {
        const headers = res.data.payload?.headers ?? [];
        const fromHeader = headers.find((h) => h.name === "From")?.value ?? "";
        const dateHeader = headers.find((h) => h.name === "Date")?.value ?? "";
        const subject = headers.find((h) => h.name === "Subject")?.value ?? "(no subject)";

        // Parse "Name <email>" or just "email"
        const match = fromHeader.match(/^(.*?)\s*<([^>]+)>$/) ?? fromHeader.match(/^([^<]+)$/);
        const email = match?.[2]?.toLowerCase() ?? fromHeader.toLowerCase().trim();
        const name = match?.[1]?.trim().replace(/^"|"$/g, "") || email;

        if (!email) continue;

        const existing = senderMap.get(email);
        if (existing) {
          existing.count += 1;
        } else {
          senderMap.set(email, { email, name, count: 1, latestDate: dateHeader, sampleSubject: subject });
        }
      }

      fetched += messages.length;
    } while (pageToken && fetched < maxFetch);

    const senders = Array.from(senderMap.values()).sort((a, b) => b.count - a.count);

    return NextResponse.json({ senders });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Gmail API error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
