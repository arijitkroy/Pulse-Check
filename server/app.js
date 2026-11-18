import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import cookieParser from "cookie-parser";
import express from "express";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminApp, adminAuth, db } from "../src/lib/firebase/admin.js";
import { getUser } from "../src/lib/auth/session.js";
import { monitorSchema } from "../src/lib/validation/monitor.js";
import { channelSchema } from "../src/lib/validation/notifications.js";
import { processDue } from "../src/lib/monitoring/engine.js";
import { processDeliveries } from "../src/lib/notifications/deliver.js";
import { processAnalytics } from "../src/lib/analytics/aggregate.js";
import { assertPublicUrl } from "../src/lib/monitoring/ssrf.js";

const app = express();
const sessionCookie = "__session";
const cookieMaxAge = 5 * 24 * 60 * 60 * 1000;
const staticRoot = path.resolve(process.cwd(), "out");

app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));
app.use(cookieParser());
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  if (req.secure || req.headers["x-forwarded-proto"] === "https") {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  }
  next();
});

// Vercel rewrites public paths into the catch-all function route.
app.use((req, res, next) => {
  if (req.url === "/api/index") req.url = "/";
  else if (req.url.startsWith("/api/index/"))
    req.url = req.url.slice(10) || "/";
  next();
});

async function requireUser(req, res, next) {
  try {
    req.user = await getUser(req);
    if (!req.user)
      return res.status(401).json({ error: "Authentication required" });
    next();
  } catch {
    res.status(401).json({ error: "Authentication required" });
  }
}

function privateMonitor(snapshot) {
  const data = snapshot.data();
  delete data.customHeaders;
  delete data.lockOwner;
  delete data.lockedUntil;
  return { id: snapshot.id, ...data };
}

function assertRequestOrigin(req) {
  if (!req.headers.origin) return;
  const allowedOrigins = [
    process.env.APP_ORIGIN,
    process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`,
    process.env.VERCEL_PROJECT_PRODUCTION_URL &&
      `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`,
  ].filter(Boolean).map((origin) => new URL(origin).origin);
  if (allowedOrigins.length && !allowedOrigins.includes(new URL(req.headers.origin).origin)) {
    throw new Error("Invalid request origin");
  }
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "pulsecheck-node",
    time: new Date().toISOString(),
  });
});

app.get("/api/public/firebase-config", (req, res) => {
  res.json({
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || "",
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || "",
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "",
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || "",
    messagingSenderId:
      process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || "",
  });
});

app.post("/api/auth/session", async (req, res) => {
  try {
    assertRequestOrigin(req);
    const { idToken } = req.body || {};
    if (typeof idToken !== "string")
      return res.status(400).json({ error: "idToken required" });
    const decoded = await adminAuth().verifyIdToken(idToken, true);
    if (!decoded.email_verified)
      return res
        .status(403)
        .json({ error: "Verify your email before signing in" });
    const cookie = await adminAuth().createSessionCookie(idToken, {
      expiresIn: cookieMaxAge,
    });
    res.cookie(sessionCookie, cookie, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: cookieMaxAge,
    });
    const profile = db().collection("users").doc(decoded.uid);
    const existingProfile = await profile.get();
    await profile.set(
      {
        uid: decoded.uid,
        email: decoded.email || null,
        displayName: decoded.name || null,
        updatedAt: Timestamp.now(),
        ...(!existingProfile.exists ? { createdAt: Timestamp.now() } : {}),
      },
      { merge: true },
    );
    return res.json({ ok: true });
  } catch (error) {
    return res
      .status(error.message === "Invalid request origin" ? 403 : 401)
      .json({ error: error.message });
  }
});

app.delete("/api/auth/session", (req, res) => {
  res.clearCookie(sessionCookie, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  });
  res.json({ ok: true });
});

app.get("/api/users/profile", requireUser, async (req, res) => {
  const snapshot = await db().collection("users").doc(req.user.uid).get();
  const profile = snapshot.data() || {};
  res.json({
    uid: req.user.uid,
    email: req.user.email,
    displayName: profile.displayName || req.user.name || "",
  });
});

app.patch("/api/users/profile", requireUser, async (req, res) => {
  const name =
    typeof req.body?.displayName === "string"
      ? req.body.displayName.trim()
      : "";
  if (!name || name.length > 80)
    return res.status(400).json({ error: "Name must be 1–80 characters" });
  await adminAuth().updateUser(req.user.uid, { displayName: name });
  await db()
    .collection("users")
    .doc(req.user.uid)
    .set({ displayName: name, updatedAt: Timestamp.now() }, { merge: true });
  res.json({ ok: true, displayName: name });
});

app.get("/api/monitors", requireUser, async (req, res) => {
  const snapshots = await db()
    .collection("users")
    .doc(req.user.uid)
    .collection("monitors")
    .orderBy("createdAt", "desc")
    .limit(100)
    .get();
  res.json({ monitors: snapshots.docs.map(privateMonitor) });
});

app.post("/api/monitors", requireUser, async (req, res) => {
  const parsed = monitorSchema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: parsed.error.flatten() });
  const now = Timestamp.now();
  const ownerMonitors = db()
    .collection("users")
    .doc(req.user.uid)
    .collection("monitors");
  const monitorLimit = Number(process.env.MAX_MONITORS_PER_USER || 100);
  const monitorCount = await ownerMonitors.count().get();
  if (monitorCount.data().count >= monitorLimit) {
    return res.status(400).json({ error: `Your deployment supports up to ${monitorLimit} monitors per account` });
  }
  const ownerRef = ownerMonitors.doc();
  const data = {
    ...parsed.data,
    ownerId: req.user.uid,
    currentStatus: "pending",
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    lastCheckedAt: null,
    nextCheckAt: now,
    averageResponseTime: 0,
    createdAt: now,
    updatedAt: now,
  };
  const batch = db().batch();
  batch.set(ownerRef, data);
  batch.set(db().collection("monitors").doc(ownerRef.id), data);
  await batch.commit();
  delete data.customHeaders;
  res.status(201).json({ monitor: { id: ownerRef.id, ...data } });
});

app.get("/api/monitors/:id", requireUser, async (req, res) => {
  const snapshot = await db()
    .collection("users")
    .doc(req.user.uid)
    .collection("monitors")
    .doc(req.params.id)
    .get();
  if (!snapshot.exists)
    return res.status(404).json({ error: "Monitor not found" });
  res.json({ monitor: privateMonitor(snapshot) });
});

app.patch("/api/monitors/:id", requireUser, async (req, res) => {
  const parsed = monitorSchema.partial().safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: parsed.error.flatten() });
  const ref = db()
    .collection("users")
    .doc(req.user.uid)
    .collection("monitors")
    .doc(req.params.id);
  const snapshot = await ref.get();
  if (!snapshot.exists)
    return res.status(404).json({ error: "Monitor not found" });
  const patch = { ...parsed.data, updatedAt: Timestamp.now() };
  const batch = db().batch();
  batch.update(ref, patch);
  batch.update(db().collection("monitors").doc(req.params.id), patch);
  if (patch.name) {
    const pages = await db()
      .collection("users")
      .doc(req.user.uid)
      .collection("statusPages")
      .where("monitorIds", "array-contains", req.params.id)
      .where("isPublished", "==", true)
      .get();
    const publicPages = await Promise.all(
      pages.docs.map((page) =>
        db().collection("publicStatusPages").doc(page.id).get(),
      ),
    );
    for (const page of publicPages) {
      if (!page.exists) continue;
      batch.update(page.ref, {
        monitors: (page.data().monitors || []).map((item) =>
          item.id === req.params.id ? { ...item, name: patch.name } : item,
        ),
        updatedAt: Timestamp.now(),
      });
    }
  }
  await batch.commit();
  res.json({ ok: true });
});

app.delete("/api/monitors/:id", requireUser, async (req, res) => {
  const ref = db()
    .collection("users")
    .doc(req.user.uid)
    .collection("monitors")
    .doc(req.params.id);
  const snapshot = await ref.get();
  if (!snapshot.exists)
    return res.status(404).json({ error: "Monitor not found" });
  const pages = await db()
    .collection("users")
    .doc(req.user.uid)
    .collection("statusPages")
    .where("monitorIds", "array-contains", req.params.id)
    .get();
  const pageRecords = await Promise.all(
    pages.docs.map(async (page) => {
      const [publicPage, metadata] = await Promise.all([
        db().collection("publicStatusPages").doc(page.id).get(),
        db().collection("statusPageMetadata").doc(page.id).get(),
      ]);
      return { page, publicPage, metadata };
    }),
  );
  const batch = db().batch();
  batch.delete(ref);
  batch.delete(db().collection("monitors").doc(req.params.id));
  for (const { page, publicPage, metadata } of pageRecords) {
    const monitorIds = page
      .data()
      .monitorIds.filter((id) => id !== req.params.id);
    batch.update(page.ref, { monitorIds, updatedAt: Timestamp.now() });
    if (metadata.exists)
      batch.update(metadata.ref, { monitorIds, updatedAt: Timestamp.now() });
    if (publicPage.exists) {
      batch.update(publicPage.ref, {
        monitors: (publicPage.data().monitors || []).filter(
          (item) => item.id !== req.params.id,
        ),
        updatedAt: Timestamp.now(),
      });
    }
  }
  await batch.commit();
  res.status(204).end();
});

app.get("/api/monitors/:id/checks", requireUser, async (req, res) => {
  const monitor = await db()
    .collection("users")
    .doc(req.user.uid)
    .collection("monitors")
    .doc(req.params.id)
    .get();
  if (!monitor.exists)
    return res.status(404).json({ error: "Monitor not found" });
  const checks = await db()
    .collection("monitors")
    .doc(req.params.id)
    .collection("checks")
    .orderBy("checkedAt", "desc")
    .limit(100)
    .get();
  res.json({
    checks: checks.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
  });
});

app.get("/api/incidents", requireUser, async (req, res) => {
  const snapshots = await db()
    .collection("incidents")
    .where("ownerId", "==", req.user.uid)
    .orderBy("startedAt", "desc")
    .limit(100)
    .get();
  res.json({
    incidents: snapshots.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
  });
});

app.get("/api/incidents/:id/updates", requireUser, async (req, res) => {
  const incident = await db().collection("incidents").doc(req.params.id).get();
  if (!incident.exists || incident.data().ownerId !== req.user.uid) {
    return res.status(404).json({ error: "Incident not found" });
  }
  const updates = await incident.ref
    .collection("updates")
    .orderBy("createdAt", "asc")
    .limit(100)
    .get();
  res.json({
    updates: updates.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
  });
});

app.post("/api/incidents/:id/updates", requireUser, async (req, res) => {
  const message =
    typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (!message || message.length > 2000)
    return res.status(400).json({ error: "Update must be 1–2000 characters" });
  const incident = db().collection("incidents").doc(req.params.id);
  const snapshot = await incident.get();
  if (!snapshot.exists || snapshot.data().ownerId !== req.user.uid)
    return res.status(404).json({ error: "Incident not found" });
  const update = {
    message,
    authorId: req.user.uid,
    authorName: req.user.name || req.user.email,
    createdAt: Timestamp.now(),
  };
  const ref = incident.collection("updates").doc();
  await ref.set(update);
  res.status(201).json({ update: { id: ref.id, ...update } });
});

app.get("/api/notifications", requireUser, async (req, res) => {
  const snapshots = await db()
    .collection("users")
    .doc(req.user.uid)
    .collection("notifications")
    .orderBy("createdAt", "desc")
    .limit(50)
    .get();
  res.json({
    notifications: snapshots.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
  });
});

app.get("/api/notifications/channels", requireUser, async (req, res) => {
  const snapshots = await db()
    .collection("users")
    .doc(req.user.uid)
    .collection("notificationChannels")
    .orderBy("createdAt", "desc")
    .get();
  res.json({
    channels: snapshots.docs.map((doc) => {
      const channel = { id: doc.id, ...doc.data() };
      delete channel.secret;
      delete channel.token;
      return channel;
    }),
  });
});

app.get("/api/notifications/deliveries", requireUser, async (req, res) => {
  const deliveries = await db()
    .collection("notificationDeliveries")
    .where("ownerId", "==", req.user.uid)
    .orderBy("createdAt", "desc")
    .limit(50)
    .get();
  res.json({
    deliveries: deliveries.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
  });
});

app.post("/api/notifications/channels", requireUser, async (req, res) => {
  const parsed = channelSchema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: parsed.error.flatten() });
  if (parsed.data.type === "webhook") {
    try {
      await assertPublicUrl(parsed.data.url);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  }
  const channelCount = await db()
    .collection("users")
    .doc(req.user.uid)
    .collection("notificationChannels")
    .count()
    .get();
  if (channelCount.data().count >= 20) {
    return res
      .status(400)
      .json({ error: "You can add up to 20 notification channels" });
  }
  const ref = db()
    .collection("users")
    .doc(req.user.uid)
    .collection("notificationChannels")
    .doc();
  const { secret, ...publicChannel } = parsed.data;
  const batch = db().batch();
  batch.set(ref, {
    ...publicChannel,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  });
  if (secret) {
    batch.set(
      db()
        .collection("notificationChannelSecrets")
        .doc(`${req.user.uid}_${ref.id}`),
      { secret },
    );
  }
  await batch.commit();
  res.status(201).json({ channel: { id: ref.id, ...publicChannel } });
});

app.delete("/api/notifications/channels/:id", requireUser, async (req, res) => {
  const ref = db()
    .collection("users")
    .doc(req.user.uid)
    .collection("notificationChannels")
    .doc(req.params.id);
  const snapshot = await ref.get();
  if (!snapshot.exists)
    return res.status(404).json({ error: "Channel not found" });
  const batch = db().batch();
  batch.delete(ref);
  batch.delete(
    db()
      .collection("notificationChannelSecrets")
      .doc(`${req.user.uid}_${ref.id}`),
  );
  await batch.commit();
  res.status(204).end();
});

app.post("/api/notifications/devices", requireUser, async (req, res) => {
  const token =
    typeof req.body?.token === "string" ? req.body.token.trim() : "";
  if (!token || token.length > 4096)
    return res.status(400).json({ error: "Invalid FCM token" });
  const ref = db()
    .collection("users")
    .doc(req.user.uid)
    .collection("notificationChannels")
    .doc(
      `push_${createHash("sha256").update(token).digest("hex").slice(0, 32)}`,
    );
  const batch = db().batch();
  batch.set(
    ref,
    {
      type: "push",
      name: req.body.name || "Browser",
      enabled: true,
      events: ["incident.opened", "incident.resolved"],
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    },
    { merge: true },
  );
  batch.set(
    db()
      .collection("notificationChannelSecrets")
      .doc(`${req.user.uid}_${ref.id}`),
    { token },
  );
  await batch.commit();
  res.status(201).json({ ok: true });
});

app.get("/api/status-pages/:slug", async (req, res) => {
  const snapshot = await db()
    .collection("publicStatusPages")
    .doc(req.params.slug)
    .get();
  if (!snapshot.exists)
    return res.status(404).json({ error: "Status page not found" });
  const metadata = await db()
    .collection("statusPageMetadata")
    .doc(req.params.slug)
    .get();
  if (!metadata.exists)
    return res.status(404).json({ error: "Status page not found" });
  const privateData = metadata.data();
  const monitors = await Promise.all(
    privateData.monitorIds.map(async (id) => {
      const monitor = await db().collection("monitors").doc(id).get();
      if (!monitor.exists || monitor.data().ownerId !== privateData.ownerId)
        return null;
      return {
        id,
        name: monitor.data().name,
        status: monitor.data().currentStatus || "pending",
      };
    }),
  );
  res.json({ ...snapshot.data(), monitors: monitors.filter(Boolean) });
});

app.get("/api/status-pages", requireUser, async (req, res) => {
  const snapshots = await db()
    .collection("users")
    .doc(req.user.uid)
    .collection("statusPages")
    .orderBy("createdAt", "desc")
    .get();
  res.json({
    pages: snapshots.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
  });
});

app.post("/api/status-pages", requireUser, async (req, res) => {
  const slug =
    typeof req.body?.slug === "string"
      ? req.body.slug.toLowerCase().trim()
      : "";
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const description =
    typeof req.body?.description === "string"
      ? req.body.description.trim()
      : "";
  const monitorIds = Array.isArray(req.body?.monitorIds)
    ? [...new Set(req.body.monitorIds)]
    : [];
  if (
    !/^[a-z0-9][a-z0-9-]{1,48}$/.test(slug) ||
    !name ||
    name.length > 100 ||
    description.length > 500 ||
    monitorIds.length > 50 ||
    monitorIds.some(
      (id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id),
    )
  ) {
    return res.status(400).json({ error: "Invalid status page settings" });
  }
  const owner = db().collection("users").doc(req.user.uid);
  const monitors = await Promise.all(
    monitorIds.map((id) => owner.collection("monitors").doc(id).get()),
  );
  if (monitors.some((snapshot) => !snapshot.exists))
    return res
      .status(400)
      .json({ error: "Every published monitor must belong to your account" });
  const statusPage = {
    ownerId: req.user.uid,
    slug,
    name,
    description,
    monitorIds,
    isPublished: req.body.isPublished === true,
    updatedAt: Timestamp.now(),
  };
  const pageRef = owner.collection("statusPages").doc(slug);
  const publicRef = db().collection("publicStatusPages").doc(slug);
  const metadataRef = db().collection("statusPageMetadata").doc(slug);
  const pagesOwned = await owner.collection("statusPages").get();
  if (pagesOwned.size >= 20 && !(await pageRef.get()).exists) {
    return res
      .status(400)
      .json({ error: "You can publish up to 20 status pages" });
  }
  const claimed = await db().runTransaction(async (tx) => {
    const [existingMetadata, existingPage] = await Promise.all([
      tx.get(metadataRef),
      tx.get(pageRef),
    ]);
    if (
      existingMetadata.exists &&
      existingMetadata.data().ownerId !== req.user.uid
    )
      return false;
    const now = Timestamp.now();
    tx.set(
      pageRef,
      {
        ...statusPage,
        createdAt: existingPage.data()?.createdAt || now,
      },
      { merge: true },
    );
    if (statusPage.isPublished) {
      tx.set(publicRef, {
        name,
        description,
        isPublished: true,
        updatedAt: now,
      });
      tx.set(metadataRef, {
        ownerId: req.user.uid,
        monitorIds,
        updatedAt: now,
      });
    } else {
      tx.delete(publicRef);
      tx.delete(metadataRef);
    }
    return true;
  });
  if (!claimed)
    return res
      .status(409)
      .json({ error: "That public slug is already in use" });
  res.status(201).json({ page: statusPage });
});

app.delete("/api/status-pages/:slug", requireUser, async (req, res) => {
  const pageRef = db()
    .collection("users")
    .doc(req.user.uid)
    .collection("statusPages")
    .doc(req.params.slug);
  const publicRef = db().collection("publicStatusPages").doc(req.params.slug);
  const metadataRef = db()
    .collection("statusPageMetadata")
    .doc(req.params.slug);
  const deleted = await db().runTransaction(async (tx) => {
    const [page, metadata] = await Promise.all([
      tx.get(pageRef),
      tx.get(metadataRef),
    ]);
    if (
      !page.exists ||
      (metadata.exists && metadata.data().ownerId !== req.user.uid)
    )
      return false;
    tx.delete(pageRef);
    tx.delete(publicRef);
    tx.delete(metadataRef);
    return true;
  });
  if (!deleted) return res.status(404).json({ error: "Status page not found" });
  res.status(204).end();
});

app.get("/api/analytics/:monitorId", requireUser, async (req, res) => {
  const monitor = await db()
    .collection("users")
    .doc(req.user.uid)
    .collection("monitors")
    .doc(req.params.monitorId)
    .get();
  if (!monitor.exists)
    return res.status(404).json({ error: "Monitor not found" });
  const range = ["24h", "7d", "30d", "90d"].includes(req.query.range)
    ? req.query.range
    : "24h";
  const end = Date.now();
  const start =
    end -
    { "24h": 86400000, "7d": 604800000, "30d": 2592000000, "90d": 7776000000 }[
      range
    ];
  const period = range === "24h" ? "hourly" : "daily";
  const snapshots = await db()
    .collection("monitors")
    .doc(req.params.monitorId)
    .collection("analytics")
    .where("periodType", "==", period)
    .where("bucketStart", ">=", Timestamp.fromMillis(start))
    .where("bucketStart", "<", Timestamp.fromMillis(end))
    .orderBy("bucketStart")
    .limit(100)
    .get();
  const buckets = snapshots.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const totals = buckets.reduce(
    (sum, item) => ({
      checks: sum.checks + item.totalChecks,
      successes: sum.successes + item.successfulChecks,
      failures: sum.failures + item.failedChecks,
      responseTime: sum.responseTime + item.totalResponseTime,
      downtime: sum.downtime + item.downtimeSeconds,
      minResponseTime:
        item.minResponseTime == null
          ? sum.minResponseTime
          : Math.min(sum.minResponseTime ?? Infinity, item.minResponseTime),
      maxResponseTime:
        item.maxResponseTime == null
          ? sum.maxResponseTime
          : Math.max(sum.maxResponseTime ?? 0, item.maxResponseTime),
    }),
    {
      checks: 0,
      successes: 0,
      failures: 0,
      responseTime: 0,
      downtime: 0,
      minResponseTime: null,
      maxResponseTime: null,
    },
  );
  res.json({
    range,
    buckets,
    summary: {
      uptimePercent: totals.checks
        ? (totals.successes / totals.checks) * 100
        : null,
      averageResponseTime: totals.checks
        ? totals.responseTime / totals.checks
        : null,
      minResponseTime: totals.minResponseTime,
      maxResponseTime: totals.maxResponseTime,
      estimatedDowntimeSeconds: totals.downtime,
      totalChecks: totals.checks,
    },
  });
});

async function runCronJob(req, res, name, run) {
  if (
    !process.env.CRON_SECRET ||
    req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`
  )
    return res.status(401).json({ error: "Unauthorized" });
  const ref = db().collection("cronRuns").doc();
  const startedAt = Timestamp.now();
  await ref.set({ job: name, status: "processing", startedAt });
  try {
    const result = await run();
    await ref.update({
      status: "completed",
      result,
      finishedAt: Timestamp.now(),
    });
    res.json(result);
  } catch (error) {
    console.error(`${name} cron failed`, error);
    await ref.update({
      status: "failed",
      error: String(error.message).slice(0, 500),
      finishedAt: Timestamp.now(),
    });
    res.status(500).json({ error: "Cron job failed" });
  }
}

app.get("/api/cron/monitor", (req, res) =>
  runCronJob(req, res, "monitor", () => processDue(12, 4)),
);

app.get("/api/cron/notifications", (req, res) =>
  runCronJob(req, res, "notifications", () => processDeliveries(9, 3)),
);

app.get("/api/cron/analytics", (req, res) =>
  runCronJob(req, res, "analytics", () => processAnalytics(20)),
);

app.use(
  "/",
  express.static(staticRoot, { index: false, maxAge: "1h", fallthrough: true }),
);
app.get("*path", async (req, res, next) => {
  if (req.path.startsWith("/api/"))
    return res.status(404).json({ error: "Not found" });
  const relative = decodeURIComponent(req.path).replace(/^\/+/, "");
  const candidates = [
    path.join(staticRoot, `${relative}.html`),
    path.join(staticRoot, relative, "index.html"),
    path.join(staticRoot, "404.html"),
  ];
  for (const candidate of candidates) {
    if (!candidate.startsWith(`${staticRoot}${path.sep}`)) continue;
    try {
      await new Promise((resolve, reject) => {
        res.sendFile(candidate, (error) => (error ? reject(error) : resolve()));
      });
      return;
    } catch {
      /* try the next static route */
    }
  }
  next();
});

app.use((error, req, res, next) => {
  console.error("request failed", error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: "Request failed" });
});

export default app;
