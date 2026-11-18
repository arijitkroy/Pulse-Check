import crypto from "node:crypto";
import nodemailer from "nodemailer";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import { db, adminApp } from "../firebase/admin.js";
import { assertPublicUrl, createSafeDispatcher } from "../monitoring/ssrf.js";

const MAX_ATTEMPTS = 5;
const DELIVERY_TIMEOUT_MS = 8000;

function smtpTransport() {
  if (
    !process.env.SMTP_HOST ||
    !process.env.SMTP_USER ||
    !process.env.SMTP_PASS
  ) {
    throw new Error("SMTP is not configured");
  }
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    connectionTimeout: DELIVERY_TIMEOUT_MS,
    greetingTimeout: DELIVERY_TIMEOUT_MS,
    socketTimeout: DELIVERY_TIMEOUT_MS,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

async function sendWebhook(channel, delivery) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  const dispatcher = createSafeDispatcher();

  try {
    const url = await assertPublicUrl(channel.url, controller.signal);
    const body = JSON.stringify({
      id: delivery.idempotencyKey,
      event: delivery.eventType,
      incident: delivery.payload,
    });
    const signature = crypto
      .createHmac("sha256", channel.secret)
      .update(body)
      .digest("hex");
    const response = await fetch(url, {
      method: "POST",
      redirect: "manual",
      dispatcher,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-PulseCheck-Signature": `sha256=${signature}`,
        "X-PulseCheck-Event": delivery.eventType,
        "Idempotency-Key": delivery.idempotencyKey,
      },
      body,
    });
    await response.body?.cancel().catch(() => {});
    if (!response.ok)
      throw new Error(`Webhook returned HTTP ${response.status}`);
  } finally {
    clearTimeout(timeout);
    await dispatcher.close();
  }
}

async function deliver(delivery) {
  const channelRef = db()
    .collection("users")
    .doc(delivery.ownerId)
    .collection("notificationChannels")
    .doc(delivery.channelId);
  const channelSnap = await channelRef.get();
  if (!channelSnap.exists || !channelSnap.data().enabled) {
    throw new Error("Notification channel is missing or disabled");
  }
  const channel = channelSnap.data();
  if (channel.type === "webhook" || channel.type === "push") {
    const secretSnap = await db()
      .collection("notificationChannelSecrets")
      .doc(`${delivery.ownerId}_${delivery.channelId}`)
      .get();
    if (!secretSnap.exists)
      throw new Error("Notification channel credential is missing");
    if (channel.type === "webhook") channel.secret = secretSnap.data().secret;
    if (channel.type === "push") channel.token = secretSnap.data().token;
  }

  if (channel.type === "email") {
    await smtpTransport().sendMail({
      from: process.env.SMTP_FROM,
      to: channel.email,
      subject: `[PulseCheck] ${delivery.payload.title}`,
      text: [
        delivery.payload.description,
        `Event: ${delivery.eventType}`,
        `Incident: ${delivery.incidentId}`,
        delivery.payload.failureReason
          ? `Reason: ${delivery.payload.failureReason}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    });
    return;
  }

  if (channel.type === "webhook") return sendWebhook(channel, delivery);
  if (channel.type === "push" && channel.token) {
    await getMessaging(adminApp()).send({
      token: channel.token,
      notification: {
        title: delivery.payload.title,
        body: delivery.payload.description || delivery.eventType,
      },
      data: { incidentId: delivery.incidentId, event: delivery.eventType },
    });
    return;
  }

  throw new Error("Unsupported notification channel type");
}

async function claim(ref, owner) {
  return db().runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) return null;
    const delivery = snapshot.data();
    const now = Timestamp.now();
    const due = delivery.nextAttemptAt?.toMillis() <= now.toMillis();
    const leaseExpired = delivery.lockedUntil?.toMillis() <= now.toMillis();
    if (delivery.status === "pending" && !due) return null;
    if (delivery.status === "processing" && !leaseExpired) return null;
    if (!["pending", "processing"].includes(delivery.status)) return null;
    tx.update(ref, {
      status: "processing",
      lockOwner: owner,
      lockedUntil: Timestamp.fromMillis(now.toMillis() + 55000),
      updatedAt: now,
    });
    return { id: ref.id, ...delivery };
  });
}

async function finish(ref, owner, error) {
  await db().runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists || snapshot.data().lockOwner !== owner) return;
    const delivery = snapshot.data();
    const attempts = (delivery.attempts || 0) + 1;
    const now = Timestamp.now();
    const patch = {
      attempts,
      updatedAt: now,
      lockOwner: FieldValue.delete(),
      lockedUntil: FieldValue.delete(),
    };

    if (!error) {
      patch.status = "delivered";
      patch.deliveredAt = now;
      patch.lastError = FieldValue.delete();
    } else if (attempts >= MAX_ATTEMPTS) {
      patch.status = "failed";
      patch.lastError = String(error.message).slice(0, 500);
    } else {
      patch.status = "pending";
      patch.lastError = String(error.message).slice(0, 500);
      patch.nextAttemptAt = Timestamp.fromMillis(
        now.toMillis() +
          Math.min(6 * 60 * 60 * 1000, 60000 * 2 ** (attempts - 1)),
      );
    }
    tx.update(ref, patch);
  });
}

export async function processDeliveries(limit = 9, concurrency = 3) {
  const now = Timestamp.now();
  const [pending, expired] = await Promise.all([
    db()
      .collection("notificationDeliveries")
      .where("status", "==", "pending")
      .where("nextAttemptAt", "<=", now)
      .limit(limit)
      .get(),
    db()
      .collection("notificationDeliveries")
      .where("status", "==", "processing")
      .where("lockedUntil", "<=", now)
      .limit(limit)
      .get(),
  ]);
  const queue = [...pending.docs, ...expired.docs].slice(0, limit);
  const scanned = queue.length;
  const owner = crypto.randomUUID();
  let delivered = 0;
  let failed = 0;

  async function worker() {
    while (queue.length) {
      const ref = queue.shift();
      const claimed = await claim(ref.ref, owner);
      if (!claimed) continue;
      let error = null;
      try {
        await deliver(claimed);
      } catch (caught) {
        error = caught;
      }
      await finish(ref.ref, owner, error);
      if (error) failed += 1;
      else delivered += 1;
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, worker),
  );
  return { scanned, delivered, failed };
}
