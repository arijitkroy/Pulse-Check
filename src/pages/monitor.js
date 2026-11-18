import { useEffect, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "../lib/firebase/client";
import { clientDb } from "../lib/firebase/client";
import {
  collection,
  limit,
  onSnapshot,
  orderBy,
  where,
  query as firestoreQuery,
} from "firebase/firestore";
import { useRouter } from "next/router";
import Link from "next/link";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const ranges = ["24h", "7d", "30d", "90d"];

export default function MonitorAnalytics() {
  const router = useRouter();
  const [monitor, setMonitor] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [checks, setChecks] = useState([]);
  const [range, setRange] = useState("24h");
  const [error, setError] = useState("");

  useEffect(
    () =>
      onAuthStateChanged(auth, async (user) => {
        if (!user) return router.replace("/login");
        if (!router.query.id) return;
        const headers = { Authorization: `Bearer ${await user.getIdToken()}` };
        const monitorResponse = await fetch(
          `/api/monitors/${router.query.id}`,
          { headers },
        );
        if (!monitorResponse.ok) {
          setError("Could not load monitor analytics.");
          return;
        }
        setMonitor((await monitorResponse.json()).monitor);
      }),
    [router, router.query.id, range],
  );

  useEffect(() => {
    let stopBuckets;
    const stopAuth = onAuthStateChanged(auth, (user) => {
      if (!user || !router.query.id) return;
      const periodType = range === "24h" ? "hourly" : "daily";
      const bucketLimit = range === "24h" ? 24 : Number.parseInt(range, 10);
      const bucketsQuery = firestoreQuery(
        collection(
          clientDb,
          "users",
          user.uid,
          "monitors",
          router.query.id,
          "analytics",
        ),
        where("periodType", "==", periodType),
        orderBy("bucketStart", "desc"),
        limit(bucketLimit),
      );
      stopBuckets = onSnapshot(bucketsQuery, (snapshot) => {
        const buckets = snapshot.docs
          .map((doc) => ({ id: doc.id, ...doc.data() }))
          .reverse();
        const total = buckets.reduce(
          (sum, bucket) => ({
            checks: sum.checks + bucket.totalChecks,
            successes: sum.successes + bucket.successfulChecks,
            responseTime: sum.responseTime + bucket.totalResponseTime,
            downtime: sum.downtime + bucket.downtimeSeconds,
            min:
              bucket.minResponseTime == null
                ? sum.min
                : Math.min(sum.min ?? Infinity, bucket.minResponseTime),
            max:
              bucket.maxResponseTime == null
                ? sum.max
                : Math.max(sum.max ?? 0, bucket.maxResponseTime),
          }),
          {
            checks: 0,
            successes: 0,
            responseTime: 0,
            downtime: 0,
            min: null,
            max: null,
          },
        );
        setAnalytics({
          buckets,
          summary: {
            uptimePercent: total.checks
              ? (total.successes / total.checks) * 100
              : null,
            averageResponseTime: total.checks
              ? total.responseTime / total.checks
              : null,
            totalChecks: total.checks,
            estimatedDowntimeSeconds: total.downtime,
            minResponseTime: total.min,
            maxResponseTime: total.max,
          },
        });
      });
    });
    return () => {
      stopAuth();
      stopBuckets?.();
    };
  }, [router.query.id, range]);

  useEffect(() => {
    let stopChecks;
    const stopAuth = onAuthStateChanged(auth, (user) => {
      if (!user || !router.query.id) return;
      const checksQuery = firestoreQuery(
        collection(
          clientDb,
          "users",
          user.uid,
          "monitors",
          router.query.id,
          "checks",
        ),
        orderBy("checkedAt", "desc"),
        limit(20),
      );
      stopChecks = onSnapshot(checksQuery, (snapshot) => {
        setChecks(snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })));
      });
    });
    return () => {
      stopAuth();
      stopChecks?.();
    };
  }, [router.query.id]);

  const chartData = (analytics?.buckets || []).map((bucket) => ({
    time: new Date(
      bucket.bucketStart.toDate?.() ||
        (bucket.bucketStart.seconds ?? bucket.bucketStart._seconds) * 1000,
    ).toLocaleString(),
    response: bucket.totalChecks
      ? Math.round(bucket.totalResponseTime / bucket.totalChecks)
      : 0,
    uptime: bucket.totalChecks
      ? Math.round((bucket.successfulChecks / bucket.totalChecks) * 10000) / 100
      : null,
  }));

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <Link href="/dashboard" className="text-indigo-700">
        ← Monitors
      </Link>
      <div className="mt-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">
            {monitor?.name || "Monitor analytics"}
          </h1>
          <p className="mt-1 text-slate-600">{monitor?.url}</p>
        </div>
        <select
          value={range}
          onChange={(event) => setRange(event.target.value)}
          className="rounded-lg border bg-white p-2"
        >
          {ranges.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </div>
      {error && <p className="mt-6 text-rose-700">{error}</p>}
      <section className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
        <Metric
          label="Uptime"
          value={
            analytics?.summary.uptimePercent == null
              ? "—"
              : `${analytics.summary.uptimePercent.toFixed(2)}%`
          }
        />
        <Metric
          label="Average response"
          value={
            analytics?.summary.averageResponseTime == null
              ? "—"
              : `${Math.round(analytics.summary.averageResponseTime)} ms`
          }
        />
        <Metric
          label="Minimum"
          value={
            analytics?.summary.minResponseTime == null
              ? "—"
              : `${Math.round(analytics.summary.minResponseTime)} ms`
          }
        />
        <Metric
          label="Maximum"
          value={
            analytics?.summary.maxResponseTime == null
              ? "—"
              : `${Math.round(analytics.summary.maxResponseTime)} ms`
          }
        />
        <Metric label="Checks" value={analytics?.summary.totalChecks ?? "—"} />
        <Metric
          label="Estimated downtime"
          value={
            analytics
              ? `${Math.round(analytics.summary.estimatedDowntimeSeconds / 60)} min`
              : "—"
          }
        />
      </section>
      <section className="mt-8 rounded-xl border bg-white p-5">
        <h2 className="font-semibold">Response time</h2>
        <div className="mt-4 h-72">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="time" hide />
              <YAxis unit=" ms" />
              <Tooltip />
              <Line
                type="monotone"
                dataKey="response"
                stroke="#4f46e5"
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          Downtime is estimated from failed checks and the configured interval.
        </p>
      </section>
      <section className="mt-8 rounded-xl border bg-white p-5">
        <h2 className="font-semibold">Recent health checks</h2>
        <div className="mt-4 divide-y">
          {checks.map((check) => (
            <div key={check.id} className="flex justify-between py-3 text-sm">
              <span>{formatDate(check.checkedAt)}</span>
              <span>{check.success ? "Up" : "Down"}</span>
              <span>{check.responseTime} ms</span>
              <span className="text-slate-500">
                {check.error || check.statusCode}
              </span>
            </div>
          ))}
          {!checks.length && (
            <p className="py-3 text-sm text-slate-500">
              No checks have been recorded.
            </p>
          )}
        </div>
      </section>
    </main>
  );
}

function Metric({ label, value }) {
  return (
    <article className="rounded-xl border bg-white p-5">
      <p className="text-sm text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold">{value}</p>
    </article>
  );
}

function formatDate(value) {
  const date = value?.toDate
    ? value.toDate()
    : new Date((value?.seconds ?? value?._seconds ?? 0) * 1000);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toLocaleString();
}
