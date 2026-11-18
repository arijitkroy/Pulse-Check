import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import { doc, onSnapshot } from "firebase/firestore";
import { clientDb } from "../lib/firebase/client";

export default function StatusPage() {
  const { query } = useRouter();
  const [page, setPage] = useState(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (!query.slug) return;
    return onSnapshot(
      doc(clientDb, "publicStatusPages", query.slug),
      (snapshot) => {
        if (!snapshot.exists() || snapshot.data().isPublished !== true) {
          setMissing(true);
          return;
        }
        setMissing(false);
        setPage(snapshot.data());
      },
      () => setMissing(true),
    );
  }, [query.slug]);

  if (missing)
    return <main className="p-12 text-center">Status page not found.</main>;
  if (!page) return <main className="p-12 text-center">Loading...</main>;

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <p className="text-sm font-semibold text-indigo-600">PULSECHECK STATUS</p>
      <h1 className="mt-2 text-3xl font-bold">{page.name}</h1>
      {page.description && (
        <p className="mt-2 text-slate-600">{page.description}</p>
      )}
      <div className="mt-8 space-y-3">
        {page.monitors.map((monitor) => (
          <article
            key={monitor.id}
            className="flex justify-between rounded-lg border bg-white p-4"
          >
            <span>{monitor.name}</span>
            <span
              className={
                monitor.status === "up" ? "text-emerald-700" : "text-rose-700"
              }
            >
              {monitor.status}
            </span>
          </article>
        ))}
      </div>
    </main>
  );
}
