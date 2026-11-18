import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { db } from "../firebase/admin.js";
import { runCheck } from "./check.js";
import { queueIncidentEvent } from "../notifications/queue.js";
const LEASE = 55000;
async function claim(ref, owner) {
  return db().runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) return null;
    const m = s.data(),
      now = Timestamp.now();
    if (
      !m.isActive ||
      (m.nextCheckAt && m.nextCheckAt.toMillis() > now.toMillis()) ||
      (m.lockedUntil && m.lockedUntil.toMillis() > now.toMillis())
    )
      return null;
    tx.update(ref, {
      lockOwner: owner,
      lockedUntil: Timestamp.fromMillis(now.toMillis() + LEASE),
      lastLockAt: now,
    });
    return m;
  });
}
async function save(ref, id, owner, m, r) {
  const now = Timestamp.now(),
    check = ref.collection("checks").doc();
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data().lockOwner !== owner) return;
    const live = snap.data(),
      fail = r.success ? 0 : (live.consecutiveFailures || 0) + 1,
      success = r.success ? (live.consecutiveSuccesses || 0) + 1 : 0,
      intervalMs = (live.intervalSeconds || 300) * 1000,
      lastScheduledAt = live.nextCheckAt?.toMillis() || now.toMillis(),
      elapsedIntervals = Math.max(
        1,
        Math.floor((now.toMillis() - lastScheduledAt) / intervalMs) + 1,
      ),
      open = await tx.get(
        db()
          .collection("incidents")
          .where("monitorId", "==", id)
          .where("status", "==", "open")
          .limit(1),
      );
    const patch = {
      currentStatus: r.success ? "up" : "down",
      consecutiveFailures: fail,
      consecutiveSuccesses: success,
      lastCheckedAt: now,
      nextCheckAt: Timestamp.fromMillis(
        lastScheduledAt + elapsedIntervals * intervalMs,
      ),
      averageResponseTime: r.responseTime,
      updatedAt: now,
      lockOwner: FieldValue.delete(),
      lockedUntil: FieldValue.delete(),
    };
    const opening = !r.success && fail >= 2 && open.empty;
    const resolving = r.success && success >= 2 && !open.empty;
    const statusChanged = live.currentStatus !== patch.currentStatus;
    let incidentRef;
    let incidentData;
    let publishedPages = [];

    if (statusChanged) {
      const pages = await tx.get(
        db()
          .collection("users")
          .doc(live.ownerId)
          .collection("statusPages")
          .where("monitorIds", "array-contains", id)
          .where("isPublished", "==", true),
      );
      publishedPages = await Promise.all(
        pages.docs.map((page) =>
          tx.get(db().collection("publicStatusPages").doc(page.id)),
        ),
      );
    }

    if (opening) {
      incidentRef = db().collection("incidents").doc();
      incidentData = {
        monitorId: id,
        ownerId: live.ownerId,
        title: `${live.name} is down`,
        description: r.error || "Health check failed",
        status: "open",
        startedAt: now,
        resolvedAt: null,
        duration: null,
        failureReason: r.error,
        createdAt: now,
        updatedAt: now,
      };
      patch.incidentStartedAt = now;
    }

    if (resolving) {
      incidentRef = open.docs[0].ref;
      const previous = open.docs[0].data();
      incidentData = {
        ...previous,
        id: incidentRef.id,
        status: "resolved",
        resolvedAt: now,
        duration: Math.max(
          0,
          now.toMillis() - (previous.startedAt?.toMillis() || now.toMillis()),
        ),
        updatedAt: now,
      };
    }

    if (opening) {
      await queueIncidentEvent(
        tx,
        live.ownerId,
        { id: incidentRef.id, ...incidentData },
        "incident.opened",
      );
    } else if (resolving) {
      await queueIncidentEvent(
        tx,
        live.ownerId,
        incidentData,
        "incident.resolved",
      );
    }

    const checkData = {
      monitorId: id,
      status: r.success ? "up" : "down",
      responseTime: r.responseTime,
      statusCode: r.statusCode,
      error: r.error,
      checkedAt: now,
      success: r.success,
    };
    tx.create(check, checkData);
    tx.create(
      db()
        .collection("users")
        .doc(live.ownerId)
        .collection("monitors")
        .doc(id)
        .collection("checks")
        .doc(check.id),
      checkData,
    );
    if (opening) {
      tx.create(incidentRef, incidentData);
      const privateIncident = db()
        .collection("users")
        .doc(live.ownerId)
        .collection("incidents")
        .doc(incidentRef.id);
      tx.create(privateIncident, incidentData);
      tx.create(incidentRef.collection("updates").doc(), {
        status: "open",
        message: incidentData.description,
        createdAt: now,
        source: "monitoring",
      });
    }
    if (resolving) {
      tx.update(incidentRef, {
        status: "resolved",
        resolvedAt: now,
        duration: incidentData.duration,
        updatedAt: now,
      });
      const privateIncident = db()
        .collection("users")
        .doc(live.ownerId)
        .collection("incidents")
        .doc(incidentRef.id);
      tx.update(privateIncident, {
        status: "resolved",
        resolvedAt: now,
        duration: incidentData.duration,
        updatedAt: now,
      });
      tx.create(incidentRef.collection("updates").doc(), {
        status: "resolved",
        message: "Monitor recovered after consecutive successful checks.",
        createdAt: now,
        source: "monitoring",
      });
    }
    for (const page of publishedPages) {
      if (!page.exists) continue;
      tx.update(page.ref, {
        monitors: (page.data().monitors || []).map((monitor) =>
          monitor.id === id
            ? { ...monitor, status: patch.currentStatus }
            : monitor,
        ),
        updatedAt: now,
      });
    }
    tx.update(ref, patch);
  });
}
export async function processDue(limit = 12, concurrency = 4) {
  // Three waves of 15-second checks fit within the configured 60-second limit.
  limit = Math.min(limit, 12);
  const now = Timestamp.now(),
    q = await db()
      .collection("monitors")
      .where("isActive", "==", true)
      .where("nextCheckAt", "<=", now)
      .orderBy("nextCheckAt")
      .limit(limit)
      .get(),
    queue = q.docs.slice(),
    owner = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let completed = 0;
  async function worker() {
    while (queue.length) {
      const doc = queue.shift(),
        m = await claim(doc.ref, owner);
      if (!m) continue;
      await save(doc.ref, doc.id, owner, m, await runCheck(m));
      completed++;
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, worker),
  );
  return { scanned: q.size, completed };
}
