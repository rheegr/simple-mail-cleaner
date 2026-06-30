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
  "1m": "Older than 1 month",
  "3m": "Older than 3 months",
  "1y": "Older than 1 year",
  all: "All time",
};

type Toast = { msg: string; type: "success" | "error"; trashLink?: boolean };

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
  const [toast, setToast] = useState<Toast | null>(null);
  const [unsubscribeResult, setUnsubscribeResult] = useState<{
    unsubscribed: boolean;
    unsubscribeUrl: string | null;
    isOneClick: boolean;
  } | null>(null);

  const showToast = (msg: string, type: "success" | "error", trashLink = false) => {
    setToast({ msg, type, trashLink });
    setTimeout(() => setToast(null), 6000);
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
      const verb = permanent ? "Permanently deleted" : "Trashed";
      showToast(`${verb} ${data.deleted} emails from ${pendingAction.sender.email}`, "success", !permanent);
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
      const uRes = await fetch("/api/gmail/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ senderEmail: pendingAction.sender.email }),
      });
      const uData = await uRes.json();
      setUnsubscribeResult(uData);

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
        showToast(`Unsubscribed + trashed ${dData.deleted} emails`, "success", true);
        setPendingAction(null);
        setUnsubscribeResult(null);
      } else if (uData.unsubscribeUrl) {
        showToast(`Trashed ${dData.deleted} emails. Open link to complete unsubscribe.`, "success", true);
      } else {
        showToast(`Trashed ${dData.deleted} emails (no unsubscribe link found)`, "success", true);
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
      <div className="min-h-screen flex items-center justify-center bg-slate-50 text-slate-900">
        Loading...
      </div>
    );
  }

  if (!session) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 gap-6">
        <div className="text-center">
          <h1 className="text-3xl font-bold mb-2 text-slate-900">Simple Mail Cleaner</h1>
          <p className="text-slate-500">Clean up your inbox by sender. Unsubscribe and delete in one click.</p>
        </div>
        <button
          onClick={() => signIn("google")}
          className="bg-teal-600 text-white font-medium px-6 py-3 rounded-xl hover:bg-teal-700 transition-colors shadow-sm"
        >
          Sign in with Google
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {/* Header */}
      <header className="border-b border-slate-200 bg-white px-6 py-4 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-slate-900">Simple Mail Cleaner</h1>
          {loading && <span className="text-sm text-slate-400">Loading...</span>}
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-slate-400">{session.user?.email}</span>
          <button
            onClick={() => signOut()}
            className="text-sm text-slate-400 hover:text-slate-700 transition-colors"
          >
            Sign out
          </button>
        </div>
      </header>

      {/* Search */}
      <div className="px-6 py-4 border-b border-slate-200 bg-white">
        <input
          type="text"
          placeholder="Search by sender name or email..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-4 py-2 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:border-teal-400 focus:ring-1 focus:ring-teal-400"
        />
        {!loading && (
          <p className="text-xs text-slate-400 mt-2">
            {filtered.length} sender{filtered.length !== 1 ? "s" : ""}
            {search && ` for "${search}"`}
          </p>
        )}
      </div>

      {/* Sender list */}
      <div className="divide-y divide-slate-100">
        {filtered.map((sender) => (
          <div
            key={sender.email}
            className="px-6 py-4 flex items-center justify-between bg-white hover:bg-slate-50 transition-colors"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium text-slate-900 truncate">{sender.name}</span>
                <span className="text-xs bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full shrink-0">
                  {sender.count}
                </span>
              </div>
              <div className="text-sm text-slate-400 truncate">{sender.email}</div>
              <div className="text-xs text-slate-300 truncate mt-0.5">{sender.sampleSubject}</div>
            </div>
            <div className="flex items-center gap-2 ml-4 shrink-0">
              <button
                onClick={() => {
                  setPendingAction({ sender, mode: "unsubscribe" });
                  setSelectedPeriod("all");
                  setUnsubscribeResult(null);
                }}
                className="text-xs bg-teal-600 hover:bg-teal-700 text-white px-3 py-1.5 rounded-lg font-medium transition-colors"
              >
                Unsubscribe & Clean
              </button>
              <button
                onClick={() => {
                  setPendingAction({ sender, mode: "delete" });
                  setSelectedPeriod("all");
                }}
                className="text-xs bg-rose-500 hover:bg-rose-600 text-white px-3 py-1.5 rounded-lg font-medium transition-colors"
              >
                Clean Out
              </button>
            </div>
          </div>
        ))}
        {!loading && filtered.length === 0 && (
          <div className="px-6 py-16 text-center text-slate-400 bg-white">No senders found</div>
        )}
      </div>

      {/* Action modal */}
      {pendingAction && (
        <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-md p-6 shadow-xl">
            <h2 className="text-lg font-semibold text-slate-900 mb-1">
              {pendingAction.mode === "unsubscribe" ? "Unsubscribe & Clean" : "Clean Out"}
            </h2>
            <p className="text-sm text-slate-500 mb-5">
              Acts on <b className="text-slate-900">every</b> email from{" "}
              <span className="font-medium text-slate-900">{pendingAction.sender.email}</span>,
              not only the one you selected.
              <br />
              <span className="text-slate-400">{pendingAction.sender.count} emails in inbox</span>
            </p>

            <p className="text-sm font-semibold text-slate-800 mb-3">Delete which emails?</p>
            <div className="grid grid-cols-2 gap-2 mb-5">
              {(Object.keys(PERIOD_LABELS) as Period[]).map((p) => (
                <button
                  key={p}
                  onClick={() => setSelectedPeriod(p)}
                  className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                    selectedPeriod === p
                      ? "bg-teal-600 text-white"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                >
                  {PERIOD_LABELS[p]}
                </button>
              ))}
            </div>

            {unsubscribeResult && !unsubscribeResult.unsubscribed && unsubscribeResult.unsubscribeUrl && (
              <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm">
                <p className="text-amber-800 font-medium mb-1">Manual unsubscribe needed</p>
                <a
                  href={unsubscribeResult.unsubscribeUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-amber-700 hover:text-amber-900 underline break-all text-xs"
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
                className="flex-1 py-2 rounded-lg bg-slate-100 text-slate-600 hover:bg-slate-200 text-sm font-medium transition-colors disabled:opacity-50"
              >
                Cancel
              </button>

              {pendingAction.mode === "unsubscribe" ? (
                <button
                  onClick={handleUnsubscribeAndDelete}
                  disabled={processing}
                  className="flex-1 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm font-semibold transition-colors disabled:opacity-50"
                >
                  {processing ? "Working..." : "Unsubscribe + Delete"}
                </button>
              ) : (
                <button
                  onClick={() => handleDelete(false)}
                  disabled={processing}
                  className="flex-1 py-2 rounded-lg bg-rose-500 hover:bg-rose-600 text-white text-sm font-semibold transition-colors disabled:opacity-50"
                >
                  {processing ? "Deleting..." : "Move to Trash"}
                </button>
              )}
            </div>

            {pendingAction.mode === "delete" && (
              <button
                onClick={() => handleDelete(true)}
                disabled={processing}
                className="w-full mt-2 py-2 rounded-lg bg-slate-50 hover:bg-slate-100 text-rose-500 text-sm font-medium border border-slate-200 transition-colors disabled:opacity-50"
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
          className={`fixed bottom-6 right-6 px-4 py-3 rounded-xl shadow-lg text-sm z-50 max-w-sm text-white leading-relaxed ${
            toast.type === "success" ? "bg-teal-600" : "bg-rose-500"
          }`}
        >
          {toast.msg}
          {toast.trashLink && (
            <>
              {" · "}
              <a
                href="https://mail.google.com/mail/u/0/#trash"
                target="_blank"
                rel="noopener noreferrer"
                className="underline opacity-85 hover:opacity-100"
              >
                View Trash
              </a>
            </>
          )}
        </div>
      )}
    </div>
  );
}
