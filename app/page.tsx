"use client";

import { useSession, signIn, signOut } from "next-auth/react";
import { useState, useEffect, useCallback } from "react";

type Sender = {
  email: string;
  name: string;
  count: number;
  latestDate: string;
  sampleSubject: string;
};

type Period = "1m" | "3m" | "1y" | "all";

const PERIOD_LABELS: Record<Period, string> = {
  "1m": "More than 1 month",
  "3m": "More than 3 months",
  "1y": "More than 1 year",
  all: "All time",
};

export default function Home() {
  const { data: session, status } = useSession();
  const [senders, setSenders] = useState<Sender[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [pendingAction, setPendingAction] = useState<{
    sender: Sender;
    mode: "delete" | "unsubscribe";
  } | null>(null);
  const [selectedPeriod, setSelectedPeriod] = useState<Period>("all");
  const [processing, setProcessing] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: "success" | "error" } | null>(null);
  const [unsubscribeResult, setUnsubscribeResult] = useState<{
    unsubscribed: boolean;
    unsubscribeUrl: string | null;
    isOneClick: boolean;
  } | null>(null);

  const showToast = (msg: string, type: "success" | "error") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  };

  const loadSenders = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/gmail/senders");
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setSenders(data.senders);
    } catch (e) {
      showToast("Failed to load senders: " + (e as Error).message, "error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (session) loadSenders();
  }, [session, loadSenders]);

  const handleDelete = async (permanent = false) => {
    if (!pendingAction) return;
    setProcessing(true);
    try {
      const res = await fetch("/api/gmail/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          senderEmail: pendingAction.sender.email,
          period: selectedPeriod,
          permanent,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      showToast(`Deleted ${data.deleted} emails from ${pendingAction.sender.email}`, "success");
      setPendingAction(null);
      await loadSenders();
    } catch (e) {
      showToast("Error: " + (e as Error).message, "error");
    } finally {
      setProcessing(false);
    }
  };

  const handleUnsubscribeAndDelete = async () => {
    if (!pendingAction) return;
    setProcessing(true);
    setUnsubscribeResult(null);

    try {
      // Step 1: Unsubscribe
      const uRes = await fetch("/api/gmail/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ senderEmail: pendingAction.sender.email }),
      });
      const uData = await uRes.json();
      setUnsubscribeResult(uData);

      // Step 2: Delete
      const dRes = await fetch("/api/gmail/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          senderEmail: pendingAction.sender.email,
          period: selectedPeriod,
          permanent: false,
        }),
      });
      const dData = await dRes.json();
      if (!dRes.ok) throw new Error(dData.error);

      if (uData.unsubscribed) {
        showToast(`Unsubscribed + deleted ${dData.deleted} emails`, "success");
        setPendingAction(null);
        setUnsubscribeResult(null);
      } else if (uData.unsubscribeUrl) {
        showToast(`Deleted ${dData.deleted} emails. Open link to complete unsubscribe.`, "success");
      } else {
        showToast(`Deleted ${dData.deleted} emails (no unsubscribe link found)`, "success");
        setPendingAction(null);
        setUnsubscribeResult(null);
      }
      await loadSenders();
    } catch (e) {
      showToast("Error: " + (e as Error).message, "error");
    } finally {
      setProcessing(false);
    }
  };

  const filtered = senders.filter(
    (s) =>
      s.email.toLowerCase().includes(search.toLowerCase()) ||
      s.name.toLowerCase().includes(search.toLowerCase())
  );

  if (status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-950 text-white">
        Loading...
      </div>
    );
  }

  if (!session) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gray-950 text-white gap-6">
        <div className="text-center">
          <h1 className="text-3xl font-bold mb-2">InboxPurge</h1>
          <p className="text-gray-400">Clean up your inbox by sender. Unsubscribe and delete in one click.</p>
        </div>
        <button
          onClick={() => signIn("google")}
          className="bg-white text-gray-900 font-medium px-6 py-3 rounded-lg hover:bg-gray-100 transition-colors"
        >
          Sign in with Google
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {/* Header */}
      <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold">InboxPurge</h1>
          {loading && <span className="text-sm text-gray-500">Loading senders...</span>}
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-400">{session.user?.email}</span>
          <button
            onClick={() => signOut()}
            className="text-sm text-gray-500 hover:text-white transition-colors"
          >
            Sign out
          </button>
        </div>
      </header>

      {/* Search */}
      <div className="px-6 py-4 border-b border-gray-800">
        <input
          type="text"
          placeholder="Search by sender name or email..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-gray-500"
        />
        {!loading && (
          <p className="text-xs text-gray-600 mt-2">
            {filtered.length} sender{filtered.length !== 1 ? "s" : ""}
            {search && ` for "${search}"`}
          </p>
        )}
      </div>

      {/* Sender list */}
      <div className="divide-y divide-gray-800">
        {filtered.map((sender) => (
          <div
            key={sender.email}
            className="px-6 py-4 flex items-center justify-between hover:bg-gray-900 transition-colors"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium truncate">{sender.name}</span>
                <span className="text-xs bg-gray-800 text-gray-400 px-2 py-0.5 rounded-full shrink-0">
                  {sender.count}
                </span>
              </div>
              <div className="text-sm text-gray-500 truncate">{sender.email}</div>
              <div className="text-xs text-gray-600 truncate mt-0.5">{sender.sampleSubject}</div>
            </div>
            <div className="flex items-center gap-2 ml-4 shrink-0">
              <button
                onClick={() => {
                  setPendingAction({ sender, mode: "unsubscribe" });
                  setSelectedPeriod("all");
                  setUnsubscribeResult(null);
                }}
                className="text-xs bg-indigo-900 hover:bg-indigo-800 text-indigo-200 px-3 py-1.5 rounded transition-colors"
              >
                Super Unsubscribe
              </button>
              <button
                onClick={() => {
                  setPendingAction({ sender, mode: "delete" });
                  setSelectedPeriod("all");
                }}
                className="text-xs bg-red-900 hover:bg-red-800 text-red-200 px-3 py-1.5 rounded transition-colors"
              >
                Super Delete
              </button>
            </div>
          </div>
        ))}
        {!loading && filtered.length === 0 && (
          <div className="px-6 py-16 text-center text-gray-600">No senders found</div>
        )}
      </div>

      {/* Action modal */}
      {pendingAction && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md p-6">
            <h2 className="text-lg font-semibold mb-1">
              {pendingAction.mode === "unsubscribe" ? "Super Unsubscribe" : "Super Delete"}
            </h2>
            <p className="text-sm text-gray-400 mb-5">
              From: <span className="text-white">{pendingAction.sender.email}</span>
              <br />
              <span className="text-gray-500">{pendingAction.sender.count} emails in inbox</span>
            </p>

            <p className="text-sm font-medium mb-3">Delete which emails?</p>
            <div className="grid grid-cols-2 gap-2 mb-6">
              {(Object.keys(PERIOD_LABELS) as Period[]).map((p) => (
                <button
                  key={p}
                  onClick={() => setSelectedPeriod(p)}
                  className={`px-3 py-2 rounded text-sm transition-colors ${
                    selectedPeriod === p
                      ? "bg-white text-gray-900 font-medium"
                      : "bg-gray-800 text-gray-300 hover:bg-gray-700"
                  }`}
                >
                  {PERIOD_LABELS[p]}
                </button>
              ))}
            </div>

            {unsubscribeResult && !unsubscribeResult.unsubscribed && unsubscribeResult.unsubscribeUrl && (
              <div className="mb-4 p-3 bg-yellow-900/30 border border-yellow-700 rounded text-sm">
                <p className="text-yellow-300 font-medium mb-1">Manual unsubscribe needed</p>
                <a
                  href={unsubscribeResult.unsubscribeUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-yellow-400 hover:text-yellow-300 underline break-all text-xs"
                >
                  Open unsubscribe page
                </a>
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={() => {
                  setPendingAction(null);
                  setUnsubscribeResult(null);
                }}
                disabled={processing}
                className="flex-1 py-2 rounded bg-gray-800 text-gray-300 hover:bg-gray-700 text-sm transition-colors disabled:opacity-50"
              >
                Cancel
              </button>

              {pendingAction.mode === "unsubscribe" ? (
                <button
                  onClick={handleUnsubscribeAndDelete}
                  disabled={processing}
                  className="flex-1 py-2 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors disabled:opacity-50"
                >
                  {processing ? "Working..." : "Unsubscribe + Delete"}
                </button>
              ) : (
                <button
                  onClick={() => handleDelete(false)}
                  disabled={processing}
                  className="flex-1 py-2 rounded bg-red-600 hover:bg-red-500 text-white text-sm font-medium transition-colors disabled:opacity-50"
                >
                  {processing ? "Deleting..." : "Move to Trash"}
                </button>
              )}
            </div>

            {pendingAction.mode === "delete" && (
              <button
                onClick={() => handleDelete(true)}
                disabled={processing}
                className="w-full mt-2 py-2 rounded bg-gray-800 hover:bg-gray-700 text-red-400 text-sm transition-colors disabled:opacity-50"
              >
                {processing ? "Deleting..." : "Permanently Delete (no recovery)"}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div
          className={`fixed bottom-6 right-6 px-4 py-3 rounded-lg shadow-lg text-sm z-50 max-w-sm ${
            toast.type === "success" ? "bg-green-900 text-green-200" : "bg-red-900 text-red-200"
          }`}
        >
          {toast.msg}
        </div>
      )}
    </div>
  );
}
