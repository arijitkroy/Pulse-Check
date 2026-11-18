import { useEffect, useState } from "react";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { auth, clientDb } from "../../lib/firebase/client";
import { useRouter } from "next/router";
import Link from "next/link";
import {
  Activity,
  Plus,
  LogOut,
  AlertCircle,
  CheckCircle2,
  Pencil,
  Trash2,
} from "lucide-react";
export default function Dashboard() {
  const [monitors, M] = useState([]),
    [loading, L] = useState(true);
  const r = useRouter();
  useEffect(() => {
    let stopMonitorUpdates;
    const stopAuthUpdates = onAuthStateChanged(auth, (u) => {
      if (!u) {
        r.replace("/login");
        return;
      }
      if (!u.emailVerified) {
        r.replace("/login");
        return;
      }
      const monitorsQuery = query(
        collection(clientDb, "users", u.uid, "monitors"),
        orderBy("createdAt", "desc"),
      );
      stopMonitorUpdates = onSnapshot(monitorsQuery, (snapshot) => {
        M(
          snapshot.docs.map((document) => ({
            id: document.id,
            ...document.data(),
          })),
        );
      });
      L(false);
    });
    return () => {
      stopAuthUpdates();
      stopMonitorUpdates?.();
    };
  }, [r]);
  async function logout() {
    await signOut(auth);
    await fetch("/api/auth/session", { method: "DELETE" });
    r.push("/login");
  }
  async function add() {
    const name = prompt("Monitor name"),
      url = prompt("Monitor URL");
    if (!name || !url) return;
    const u = auth.currentUser,
      res = await fetch("/api/monitors", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${await u.getIdToken()}`,
        },
        body: JSON.stringify({
          name,
          url,
          intervalSeconds: Number(
            process.env.NEXT_PUBLIC_MIN_MONITOR_INTERVAL_SECONDS || 300,
          ),
          timeoutMs: 10000,
          expectedStatusCodes: [200],
          method: "GET",
          isActive: true,
        }),
      });
    if (!res.ok)
      alert("Could not create monitor. Check the URL and try again.");
  }
  async function edit(monitor) {
    const name = prompt("Monitor name", monitor.name);
    const url = prompt("Monitor URL", monitor.url);
    if (!name || !url) return;
    const response = await fetch(`/api/monitors/${monitor.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${await auth.currentUser.getIdToken()}`,
      },
      body: JSON.stringify({ name, url }),
    });
    if (!response.ok)
      alert("Could not update monitor. Check the URL and try again.");
  }
  async function remove(monitor) {
    if (!confirm(`Delete ${monitor.name} and its monitor configuration?`))
      return;
    const response = await fetch(`/api/monitors/${monitor.id}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${await auth.currentUser.getIdToken()}`,
      },
    });
    if (!response.ok) alert("Could not delete monitor.");
  }
  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <header className="flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2 text-xl font-bold">
          <Activity className="text-indigo-600" />
          PulseCheck
        </Link>
        <nav className="flex items-center gap-4 text-sm">
          <Link
            href="/incidents"
            className="text-slate-600 hover:text-indigo-700"
          >
            Incidents
          </Link>
          <Link
            href="/settings"
            className="text-slate-600 hover:text-indigo-700"
          >
            Settings
          </Link>
          <button
            onClick={logout}
            className="flex items-center gap-2 text-slate-600"
          >
            <LogOut size={18} />
            Log out
          </button>
        </nav>
      </header>
      <div className="mt-12 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Monitors</h1>
          <p className="mt-1 text-slate-600">A view of your services.</p>
        </div>
        <button
          onClick={add}
          className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-white"
        >
          <Plus size={18} />
          Add monitor
        </button>
      </div>
      {loading ? (
        <p className="mt-10">Loading...</p>
      ) : (
        <div className="mt-8 grid gap-4">
          {monitors.map((m) => (
            <article
              key={m.id}
              className="flex items-center justify-between rounded-xl border bg-white p-5"
            >
              <div>
                <h2 className="font-semibold">{m.name}</h2>
                <Link
                  href={`/monitor?id=${m.id}`}
                  className="mt-1 block text-sm text-slate-500 hover:text-indigo-700"
                >
                  {m.url} · View analytics
                </Link>
              </div>
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2 text-sm">
                  {m.currentStatus === "up" ? (
                    <CheckCircle2 className="text-emerald-600" />
                  ) : (
                    <AlertCircle className="text-amber-500" />
                  )}
                  {m.currentStatus || "pending"}
                </div>
                <button onClick={() => edit(m)} aria-label={`Edit ${m.name}`}>
                  <Pencil size={17} />
                </button>
                <button
                  onClick={() => remove(m)}
                  aria-label={`Delete ${m.name}`}
                >
                  <Trash2 size={17} />
                </button>
              </div>
            </article>
          ))}
          {!monitors.length && (
            <p className="rounded-xl border bg-white p-10 text-center text-slate-500">
              No monitors yet. Add one to get started.
            </p>
          )}
        </div>
      )}
    </main>
  );
}
