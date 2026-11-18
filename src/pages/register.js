import { useState } from "react";
import Link from "next/link";
import {
  createUserWithEmailAndPassword,
  sendEmailVerification,
  updateProfile,
} from "firebase/auth";
import { auth } from "../lib/firebase/client";
export default function Register() {
  const [name, N] = useState(""),
    [email, E] = useState(""),
    [password, P] = useState(""),
    [message, M] = useState("");
  async function submit(e) {
    e.preventDefault();
    try {
      const c = await createUserWithEmailAndPassword(auth, email, password);
      await updateProfile(c.user, { displayName: name });
      await sendEmailVerification(c.user);
      M("Account created. Verify your email, then log in.");
    } catch (x) {
      M(x.message);
    }
  }
  return (
    <main className="mx-auto mt-24 max-w-md rounded-2xl border bg-white p-8">
      <h1 className="text-2xl font-bold">Create your account</h1>
      <form onSubmit={submit} className="mt-6 space-y-4">
        <input
          required
          placeholder="Name"
          value={name}
          onChange={(e) => N(e.target.value)}
          className="w-full rounded-lg border p-3"
        />
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
          minLength="8"
          type="password"
          placeholder="Password (8+ characters)"
          value={password}
          onChange={(e) => P(e.target.value)}
          className="w-full rounded-lg border p-3"
        />
        <button className="w-full rounded-lg bg-indigo-600 p-3 text-white">
          Register
        </button>
      </form>
      {message && <p className="mt-4 text-sm">{message}</p>}
      <p className="mt-5 text-sm">
        Already registered?{" "}
        <Link href="/login" className="text-indigo-700">
          Log in
        </Link>
      </p>
    </main>
  );
}
