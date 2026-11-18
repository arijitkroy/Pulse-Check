import { useEffect, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { auth, clientDb } from "../lib/firebase/client";
import { useRouter } from "next/router";
import Link from "next/link";

export default function IncidentsPage() {
  const router = useRouter();
  const [incidents, setIncidents] = useState([]);
  const [updates, setUpdates] = useState({});
  const [message, setMessage] = useState({});
  const [error, setError] = useState("");

  useEffect(() => {
    let stopIncidentUpdates;
    const stopAuthUpdates = onAuthStateChanged(auth, async (user) => {
      if (!user) return router.replace("/login");
      const response = await fetch("/api/incidents", {
        headers: { Authorization: `Bearer ${await user.getIdToken()}` },
      });
      if (!response.ok) return setError("Could not load incidents.");
      const incidentQuery = query(
        collection(clientDb, "users", user.uid, "incidents"),
        orderBy("startedAt", "desc"),
      );
      stopIncidentUpdates = onSnapshot(incidentQuery, (snapshot) => {
        setIncidents(
          snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
        );
      });
    });
    return () => {
      stopAuthUpdates();
      stopIncidentUpdates?.();
    };
  }, [router]);

  async function loadUpdates(incidentId) {
    const token = await auth.currentUser.getIdToken();
    const response = await fetch(`/api/incidents/${incidentId}/updates`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.ok) {
      const data = await response.json();
      setUpdates((current) => ({ ...current, [incidentId]: data.updates }));
    }
  }

  async function addUpdate(incidentId) {
    const text = message[incidentId]?.trim();
    if (!text) return;
    const response = await fetch(`/api/incidents/${incidentId}/updates`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${await auth.currentUser.getIdToken()}`,
      },
      body: JSON.stringify({ message: text }),
    });
    if (!response.ok) return setError("Could not add incident update.");
    setMessage((current) => ({ ...current, [incidentId]: "" }));
    await loadUpdates(incidentId);
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      <Link href="/dashboard" className="text-indigo-700">
        Back to dashboard
      </Link>
      <h1 className="mt-6 text-3xl font-bold">Incident history</h1>
      {error && <p className="mt-4 text-rose-700">{error}</p>}
      <div className="mt-8 space-y-4">
        {incidents.map((incident) => (
          <article key={incident.id} className="rounded-xl border bg-white p-5">
            <div className="flex flex-wrap justify-between gap-3">
              <div>
                <h2 className="font-semibold">{incident.title}</h2>
                <p className="mt-1 text-sm text-slate-600">
                  {incident.description}
                </p>
              </div>
              <span
                className={
                  incident.status === "open"
                    ? "text-rose-700"
                    : "text-emerald-700"
                }
              >
                {incident.status}
              </span>
            </div>
            <p className="mt-3 text-xs text-slate-500">
              Started {formatDate(incident.startedAt)}
              {incident.resolvedAt
                ? ` · Resolved ${formatDate(incident.resolvedAt)}`
                : ""}
            </p>
            <button
              onClick={() => loadUpdates(incident.id)}
              className="mt-4 text-sm text-indigo-700"
            >
              Load updates
            </button>
            <div className="mt-3 space-y-2">
              {(updates[incident.id] || []).map((update) => (
                <p key={update.id} className="rounded bg-slate-50 p-3 text-sm">
                  {update.message}
                </p>
              ))}
            </div>
            <div className="mt-4 flex gap-2">
              <input
                value={message[incident.id] || ""}
                onChange={(event) =>
                  setMessage((current) => ({
                    ...current,
                    [incident.id]: event.target.value,
                  }))
                }
                placeholder="Add an update"
                className="min-w-0 flex-1 rounded-lg border p-2"
              />
              <button
                onClick={() => addUpdate(incident.id)}
                className="rounded-lg bg-indigo-600 px-4 text-white"
              >
                Post
              </button>
            </div>
          </article>
        ))}
        {!incidents.length && (
          <p className="rounded-xl border bg-white p-10 text-center text-slate-500">
            No incidents recorded.
          </p>
        )}
      </div>
    </main>
  );
}

function formatDate(value) {
  const seconds = value?.seconds ?? value?._seconds;
  const date = value?.toDate
    ? value.toDate()
    : new Date(seconds == null ? value : seconds * 1000);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toLocaleString();
}
