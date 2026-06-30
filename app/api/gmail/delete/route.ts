import { auth } from "@/auth";
import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";

// older_than query values per period option
const PERIOD_QUERY: Record<string, string> = {
  "1m": "older_than:1m",
  "3m": "older_than:3m",
  "1y": "older_than:1y",
  all: "",
};

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.accessToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { senderEmail, period, permanent = false } = await req.json();
  if (!senderEmail || !period) {
    return NextResponse.json({ error: "Missing senderEmail or period" }, { status: 400 });
  }

  const periodQuery = PERIOD_QUERY[period];
  if (periodQuery === undefined) {
    return NextResponse.json({ error: "Invalid period" }, { status: 400 });
  }

  const oauth2 = new google.auth.OAuth2();
  oauth2.setCredentials({ access_token: session.accessToken });
  const gmail = google.gmail({ version: "v1", auth: oauth2 });

  try {
    const q = [`from:${senderEmail}`, periodQuery].filter(Boolean).join(" ");
    const allIds: string[] = [];
    let pageToken: string | undefined;

    // Collect all matching message IDs
    do {
      const listRes = await gmail.users.messages.list({
        userId: "me",
        q,
        maxResults: 500,
        pageToken,
        fields: "messages/id,nextPageToken",
      });
      const messages = listRes.data.messages ?? [];
      allIds.push(...messages.map((m) => m.id!));
      pageToken = listRes.data.nextPageToken ?? undefined;
    } while (pageToken);

    if (allIds.length === 0) {
      return NextResponse.json({ deleted: 0 });
    }

    // Delete in batches of 1000
    const BATCH = 1000;
    for (let i = 0; i < allIds.length; i += BATCH) {
      const chunk = allIds.slice(i, i + BATCH);
      if (permanent) {
        await gmail.users.messages.batchDelete({ userId: "me", requestBody: { ids: chunk } });
      } else {
        await gmail.users.messages.batchModify({
          userId: "me",
          requestBody: { ids: chunk, addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
        });
      }
    }

    return NextResponse.json({ deleted: allIds.length });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Gmail API error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
