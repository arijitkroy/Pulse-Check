import { useState } from "react";
import Link from "next/link";
import {
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
} from "firebase/auth";
import { auth } from "../lib/firebase/client";
import { useRouter } from "next/router";
export default function Login() {
  const [email, E] = useState(""),
    [password, P] = useState(""),
    [message, M] = useState("");
  const r = useRouter();
  async function login(e) {
    e.preventDefault();
    try {
      const c = await signInWithEmailAndPassword(auth, email, password),
        res = await fetch("/api/auth/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idToken: await c.user.getIdToken() }),
        });
      if (!res.ok) throw Error((await res.json()).error);
      r.push("/dashboard");
    } catch (x) {
      M(x.message);
    }
  }
  async function reset() {
    try {
      await sendPasswordResetEmail(auth, email);
      M("Password reset email sent.");
    } catch (x) {
      M(x.message);
    }
  }
  return (
    <main className="mx-auto mt-24 max-w-md rounded-2xl border bg-white p-8">
      <h1 className="text-2xl font-bold">Welcome back</h1>
      <form onSubmit={login} className="mt-6 space-y-4">
        <input
          required
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => E(e.target.value)}
          className="w-full rounded-lg border p-3"
        />
        <input
          required
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => P(e.target.value)}
          className="w-full rounded-lg border p-3"
        />
        <button className="w-full rounded-lg bg-indigo-600 p-3 text-white">
          Log in
        </button>
      </form>
      {message && <p className="mt-3 text-sm text-red-600">{message}</p>}
      <button onClick={reset} className="mt-4 text-sm text-indigo-700">
        Forgot password?
      </button>
      <p className="mt-5 text-sm">
        New here?{" "}
        <Link href="/register" className="text-indigo-700">
          Create an account
        </Link>
      </p>
    </main>
  );
}
