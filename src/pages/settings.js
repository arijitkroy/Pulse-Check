import { useEffect, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { getMessaging, getToken, isSupported } from "firebase/messaging";
import { auth, clientDb, firebaseApp } from "../lib/firebase/client";
import { useRouter } from "next/router";
import Link from "next/link";

export default function SettingsPage() {
  const router = useRouter();
  const [profile, setProfile] = useState({ displayName: "", email: "" });
  const [channels, setChannels] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [deliveries, setDeliveries] = useState([]);
  const [pages, setPages] = useState([]);
  const [monitors, setMonitors] = useState([]);
  const [channelForm, setChannelForm] = useState({
    type: "email",
    name: "",
    email: "",
    url: "",
    secret: "",
    events: ["incident.opened", "incident.resolved"],
  });
  const [pageForm, setPageForm] = useState({
    slug: "",
    name: "",
    description: "",
    monitorIds: [],
    isPublished: true,
  });
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let stopNotifications;
    const stopAuthUpdates = onAuthStateChanged(auth, async (user) => {
      if (!user) return router.replace("/login");
      const token = await user.getIdToken();
      const headers = { Authorization: `Bearer ${token}` };
      const [
        profileResponse,
        channelResponse,
        deliveryResponse,
        pageResponse,
        monitorResponse,
      ] = await Promise.all([
        fetch("/api/users/profile", { headers }),
        fetch("/api/notifications/channels", { headers }),
        fetch("/api/notifications/deliveries", { headers }),
        fetch("/api/status-pages", { headers }),
        fetch("/api/monitors", { headers }),
      ]);
      if (profileResponse.ok) setProfile(await profileResponse.json());
      if (channelResponse.ok)
        setChannels((await channelResponse.json()).channels);
      if (deliveryResponse.ok)
        setDeliveries((await deliveryResponse.json()).deliveries);
      if (pageResponse.ok) setPages((await pageResponse.json()).pages);
      if (monitorResponse.ok)
        setMonitors((await monitorResponse.json()).monitors);
      const notificationsQuery = query(
        collection(clientDb, "users", user.uid, "notifications"),
        orderBy("createdAt", "desc"),
      );
      stopNotifications = onSnapshot(notificationsQuery, (snapshot) => {
        setNotifications(
          snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
        );
      });
    });
    return () => {
      stopAuthUpdates();
      stopNotifications?.();
    };
  }, [router]);

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        Authorization: `Bearer ${await auth.currentUser.getIdToken()}`,
        ...options.headers,
      },
    });
    if (!response.ok)
      throw new Error((await response.json()).error || "Request failed");
    return response.status === 204 ? null : response.json();
  }

  async function saveProfile(event) {
    event.preventDefault();
    try {
      const result = await api("/api/users/profile", {
        method: "PATCH",
        body: JSON.stringify(profile),
      });
      setProfile((current) => ({
        ...current,
        displayName: result.displayName,
      }));
      setNotice("Profile saved.");
    } catch (error) {
      setNotice(error.message);
    }
  }

  async function saveChannel(event) {
    event.preventDefault();
    try {
      const data = { ...channelForm };
      if (data.type === "email") {
        delete data.url;
        delete data.secret;
      } else delete data.email;
      const result = await api("/api/notifications/channels", {
        method: "POST",
        body: JSON.stringify(data),
      });
      setChannels((current) => [...current, result.channel]);
      setChannelForm({
        type: "email",
        name: "",
        email: "",
        url: "",
        secret: "",
        events: ["incident.opened", "incident.resolved"],
      });
      setNotice("Notification channel added.");
    } catch (error) {
      setNotice(error.message);
    }
  }

  async function enablePush() {
    try {
      if (
        !process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY ||
        !(await isSupported())
      ) {
        throw new Error(
          "Browser push is not configured for this Firebase project.",
        );
      }
      const permission = await Notification.requestPermission();
      if (permission !== "granted")
        throw new Error("Notification permission was not granted.");
      const registration = await navigator.serviceWorker.register(
        "/firebase-messaging-sw.js",
      );
      const token = await getToken(getMessaging(firebaseApp), {
        vapidKey: process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY,
        serviceWorkerRegistration: registration,
      });
      if (!token) throw new Error("Firebase did not issue a browser token.");
      await api("/api/notifications/devices", {
        method: "POST",
        body: JSON.stringify({ token }),
      });
      setNotice("This browser is registered for incident notifications.");
      const refreshed = await api("/api/notifications/channels");
      setChannels(refreshed.channels);
    } catch (error) {
      setNotice(error.message);
    }
  }

  async function deleteChannel(id) {
    try {
      await api(`/api/notifications/channels/${id}`, { method: "DELETE" });
      setChannels((current) => current.filter((channel) => channel.id !== id));
    } catch (error) {
      setNotice(error.message);
    }
  }

  async function saveStatusPage(event) {
    event.preventDefault();
    try {
      const result = await api("/api/status-pages", {
        method: "POST",
        body: JSON.stringify(pageForm),
      });
      setPages((current) => [
        result.page,
        ...current.filter((page) => page.slug !== result.page.slug),
      ]);
      setPageForm({
        slug: "",
        name: "",
        description: "",
        monitorIds: [],
        isPublished: true,
      });
      setNotice("Status page saved.");
    } catch (error) {
      setNotice(error.message);
    }
  }

  async function deletePage(slug) {
    try {
      await api(`/api/status-pages/${slug}`, { method: "DELETE" });
      setPages((current) => current.filter((page) => page.slug !== slug));
    } catch (error) {
      setNotice(error.message);
    }
  }

  function toggleMonitor(id) {
    setPageForm((current) => ({
      ...current,
      monitorIds: current.monitorIds.includes(id)
        ? current.monitorIds.filter((item) => item !== id)
        : [...current.monitorIds, id],
    }));
  }

  return (
    <main className="mx-auto max-w-5xl space-y-8 px-6 py-8">
      <Link href="/dashboard" className="text-indigo-700">
        ← Dashboard
      </Link>
      <div>
        <h1 className="text-3xl font-bold">Settings</h1>
        {notice && <p className="mt-2 text-sm text-indigo-700">{notice}</p>}
      </div>
      <section className="rounded-xl border bg-white p-6">
        <h2 className="text-xl font-semibold">Profile</h2>
        <form onSubmit={saveProfile} className="mt-4 flex flex-wrap gap-3">
          <input
            value={profile.displayName}
            onChange={(event) =>
              setProfile({ ...profile, displayName: event.target.value })
            }
            className="min-w-64 rounded-lg border p-2"
            placeholder="Display name"
          />
          <input
            value={profile.email}
            readOnly
            className="min-w-64 rounded-lg border bg-slate-50 p-2"
          />
          <button className="rounded-lg bg-indigo-600 px-4 text-white">
            Save profile
          </button>
        </form>
      </section>
      <section className="rounded-xl border bg-white p-6">
        <h2 className="text-xl font-semibold">Recent notifications</h2>
        <div className="mt-4 space-y-2">
          {notifications.map((notification) => (
            <article
              key={notification.id}
              className="rounded-lg bg-slate-50 p-3"
            >
              <p className="font-medium">{notification.title}</p>
              <p className="mt-1 text-xs text-slate-500">{notification.type}</p>
            </article>
          ))}
          {!notifications.length && (
            <p className="text-sm text-slate-500">No notifications yet.</p>
          )}
        </div>
        <h3 className="mt-6 font-semibold">Delivery history</h3>
        <div className="mt-3 space-y-2">
          {deliveries.map((delivery) => (
            <article
              key={delivery.id}
              className="flex flex-wrap justify-between gap-2 rounded-lg border p-3 text-sm"
            >
              <span>{delivery.eventType}</span>
              <span>{delivery.status}</span>
              <span>{delivery.attempts || 0} attempts</span>
              {delivery.lastError && (
                <span className="text-rose-700">{delivery.lastError}</span>
              )}
            </article>
          ))}
          {!deliveries.length && (
            <p className="text-sm text-slate-500">No deliveries yet.</p>
          )}
        </div>
      </section>
      <section className="rounded-xl border bg-white p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">Notification channels</h2>
          <button onClick={enablePush} className="rounded-lg border px-3 py-2">
            Enable browser push
          </button>
        </div>
        <div className="mt-4 space-y-2">
          {channels.map((channel) => (
            <div
              key={channel.id}
              className="flex items-center justify-between rounded-lg bg-slate-50 p-3"
            >
              <span>
                {channel.name} · {channel.type}
              </span>
              <button
                onClick={() => deleteChannel(channel.id)}
                className="text-sm text-rose-700"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
        <form onSubmit={saveChannel} className="mt-6 grid gap-3 sm:grid-cols-2">
          <select
            value={channelForm.type}
            onChange={(event) =>
              setChannelForm({ ...channelForm, type: event.target.value })
            }
            className="rounded-lg border p-2"
          >
            <option value="email">Email</option>
            <option value="webhook">Webhook</option>
          </select>
          <input
            required
            value={channelForm.name}
            onChange={(event) =>
              setChannelForm({ ...channelForm, name: event.target.value })
            }
            className="rounded-lg border p-2"
            placeholder="Channel name"
          />
          {channelForm.type === "email" ? (
            <input
              required
              type="email"
              value={channelForm.email}
              onChange={(event) =>
                setChannelForm({ ...channelForm, email: event.target.value })
              }
              className="rounded-lg border p-2"
              placeholder="Recipient email"
            />
          ) : (
            <>
              <input
                required
                type="url"
                value={channelForm.url}
                onChange={(event) =>
                  setChannelForm({ ...channelForm, url: event.target.value })
                }
                className="rounded-lg border p-2"
                placeholder="Webhook URL"
              />
              <input
                required
                minLength={32}
                value={channelForm.secret}
                onChange={(event) =>
                  setChannelForm({ ...channelForm, secret: event.target.value })
                }
                className="rounded-lg border p-2 sm:col-span-2"
                placeholder="Signing secret (at least 32 characters)"
              />
            </>
          )}
          <button className="rounded-lg bg-indigo-600 p-2 text-white sm:col-span-2">
            Add channel
          </button>
        </form>
        <p className="mt-3 text-xs text-slate-500">
          Webhook requests use an HMAC SHA-256 signature in
          X-PulseCheck-Signature. SMTP delivery requires configured SMTP
          credentials.
        </p>
      </section>
      <section className="rounded-xl border bg-white p-6">
        <h2 className="text-xl font-semibold">Public status pages</h2>
        <div className="mt-4 space-y-2">
          {pages.map((page) => (
            <div
              key={page.slug}
              className="flex justify-between rounded-lg bg-slate-50 p-3"
            >
              <a
                href={`/status?slug=${encodeURIComponent(page.slug)}`}
                className="text-indigo-700"
              >
                {page.name} · /status?slug={page.slug}
              </a>
              <button
                onClick={() => deletePage(page.slug)}
                className="text-sm text-rose-700"
              >
                Delete
              </button>
            </div>
          ))}
        </div>
        <form onSubmit={saveStatusPage} className="mt-6 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <input
              required
              minLength={2}
              maxLength={49}
              pattern="[a-z0-9][a-z0-9-]+"
              value={pageForm.slug}
              onChange={(event) =>
                setPageForm({ ...pageForm, slug: event.target.value })
              }
              className="rounded-lg border p-2"
              placeholder="Public slug"
            />
            <input
              required
              value={pageForm.name}
              onChange={(event) =>
                setPageForm({ ...pageForm, name: event.target.value })
              }
              className="rounded-lg border p-2"
              placeholder="Page title"
            />
          </div>
          <textarea
            value={pageForm.description}
            onChange={(event) =>
              setPageForm({ ...pageForm, description: event.target.value })
            }
            className="w-full rounded-lg border p-2"
            placeholder="Description"
          />
          <div className="flex flex-wrap gap-3">
            {monitors.map((monitor) => (
              <label key={monitor.id} className="flex gap-2">
                <input
                  type="checkbox"
                  checked={pageForm.monitorIds.includes(monitor.id)}
                  onChange={() => toggleMonitor(monitor.id)}
                />
                {monitor.name}
              </label>
            ))}
          </div>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={pageForm.isPublished}
              onChange={(event) =>
                setPageForm({ ...pageForm, isPublished: event.target.checked })
              }
            />
            Publish page
          </label>
          <button className="rounded-lg bg-indigo-600 px-4 py-2 text-white">
            Save status page
          </button>
        </form>
      </section>
    </main>
  );
}
