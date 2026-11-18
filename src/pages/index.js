import Link from "next/link";
import { Activity, ShieldCheck, Zap } from "lucide-react";
export default function Home() {
  return (
    <main className="min-h-screen bg-white">
      <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <div className="flex items-center gap-2 text-xl font-bold">
          <Activity className="text-indigo-600" />
          PulseCheck
        </div>
        <div className="flex gap-3">
          <Link className="rounded-lg px-4 py-2" href="/login">
            Log in
          </Link>
          <Link
            className="rounded-lg bg-indigo-600 px-4 py-2 text-white"
            href="/register"
          >
            Get started
          </Link>
        </div>
      </nav>
      <section className="mx-auto max-w-5xl px-6 py-24 text-center">
        <p className="font-semibold text-indigo-600">
          Uptime monitoring made simple
        </p>
        <h1 className="mt-4 text-5xl font-bold tracking-tight">
          Know when your services
          <br />
          need attention.
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-slate-600">
          Monitor websites, track incidents, and keep your team informed with a
          serverless uptime dashboard.
        </p>
        <Link
          href="/register"
          className="mt-8 inline-block rounded-lg bg-indigo-600 px-6 py-3 font-medium text-white"
        >
          Create your account
        </Link>
        <div className="mt-20 grid gap-6 text-left md:grid-cols-3">
          {[
            [
              ShieldCheck,
              "Reliable checks",
              "Scheduled checks with incident detection.",
            ],
            [
              Activity,
              "Clear status",
              "A focused view of service health and history.",
            ],
            [Zap, "Fast setup", "Add a monitor in a few moments."],
          ].map(([Icon, title, copy]) => (
            <article key={title} className="rounded-xl border p-6">
              <Icon className="text-indigo-600" />
              <h2 className="mt-4 font-semibold">{title}</h2>
              <p className="mt-2 text-slate-600">{copy}</p>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
