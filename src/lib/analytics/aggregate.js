import crypto from "node:crypto";
import { FieldPath, FieldValue, Timestamp } from "firebase-admin/firestore";
import { db } from "../firebase/admin.js";

const STATE_LOCK_MS = 45000;
const CHECK_PAGE_SIZE = 250;

function bucketStart(date, unit) {
  const start = new Date(date);
  start.setUTCMinutes(0, 0, 0);
  if (unit === "daily") start.setUTCHours(0, 0, 0, 0);
  return start;
}

function bucketId(unit, start) {
  const iso = start.toISOString();
  return `${unit}-${unit === "hourly" ? iso.slice(0, 13) : iso.slice(0, 10)}`;
}

async function aggregateMonitor(monitorDoc, owner) {
  const stateRef = monitorDoc.ref.collection("analyticsState").doc("cursor");
  const claim = await db().runTransaction(async (tx) => {
    const snapshot = await tx.get(stateRef);
    const state = snapshot.data() || {};
    const now = Timestamp.now();
    if (state.lockedUntil?.toMillis() > now.toMillis()) return null;
    tx.set(
      stateRef,
      {
        lockOwner: owner,
        lockedUntil: Timestamp.fromMillis(now.toMillis() + STATE_LOCK_MS),
        updatedAt: now,
      },
      { merge: true },
    );
    return state;
  });
  if (!claim) return 0;

  const monitor = monitorDoc.data();
  const checksRef = monitorDoc.ref.collection("checks");
  let checksQuery = checksRef
    .orderBy("checkedAt")
    .orderBy(FieldPath.documentId())
    .limit(CHECK_PAGE_SIZE);
  if (claim.lastCheckedAt) {
    checksQuery = checksQuery.startAfter(
      claim.lastCheckedAt,
      claim.lastCheckId,
    );
  } else if (monitor.createdAt) {
    checksQuery = checksQuery.startAt(monitor.createdAt, "");
  }
  const checks = await checksQuery.get();

  if (checks.empty) {
    await releaseState(stateRef, owner, claim.lastCheckedAt, claim.lastCheckId);
    return 0;
  }

  const groups = new Map();
  for (const check of checks.docs) {
    const data = check.data();
    if (!data.checkedAt) continue;
    const date = data.checkedAt.toDate();
    for (const unit of ["hourly", "daily"]) {
      const start = bucketStart(date, unit);
      const id = bucketId(unit, start);
      const group = groups.get(id) || {
        id,
        unit,
        start,
        totalChecks: 0,
        successfulChecks: 0,
        failedChecks: 0,
        totalResponseTime: 0,
        minResponseTime: null,
        maxResponseTime: null,
        downtimeSeconds: 0,
      };
      group.totalChecks += 1;
      group.successfulChecks += data.success ? 1 : 0;
      group.failedChecks += data.success ? 0 : 1;
      group.totalResponseTime += Number(data.responseTime || 0);
      if (data.responseTime != null) {
        group.minResponseTime =
          group.minResponseTime == null
            ? data.responseTime
            : Math.min(group.minResponseTime, data.responseTime);
        group.maxResponseTime =
          group.maxResponseTime == null
            ? data.responseTime
            : Math.max(group.maxResponseTime, data.responseTime);
      }
      if (!data.success)
        group.downtimeSeconds += monitor.intervalSeconds || 300;
      groups.set(id, group);
    }
  }

  const lastCheck = checks.docs.at(-1);
  await db().runTransaction(async (tx) => {
    const stateSnapshot = await tx.get(stateRef);
    if (!stateSnapshot.exists || stateSnapshot.data().lockOwner !== owner)
      return;
    const bucketRefs = [...groups.values()].map((group) =>
      monitorDoc.ref.collection("analytics").doc(group.id),
    );
    const privateBucketRefs = [...groups.values()].map((group) =>
      db()
        .collection("users")
        .doc(monitor.ownerId)
        .collection("monitors")
        .doc(monitorDoc.id)
        .collection("analytics")
        .doc(group.id),
    );
    const bucketSnapshots = await Promise.all(
      [...bucketRefs, ...privateBucketRefs].map((ref) => tx.get(ref)),
    );
    const now = Timestamp.now();
    for (const [index, group] of [...groups.values()].entries()) {
      const previous = bucketSnapshots[index].data() || {};
      const ref = bucketRefs[index];
      const updated = {
        periodType: group.unit,
        bucketStart: Timestamp.fromDate(group.start),
        bucketEnd: Timestamp.fromMillis(
          group.start.getTime() +
            (group.unit === "hourly" ? 3600000 : 86400000),
        ),
        totalChecks: (previous.totalChecks || 0) + group.totalChecks,
        successfulChecks:
          (previous.successfulChecks || 0) + group.successfulChecks,
        failedChecks: (previous.failedChecks || 0) + group.failedChecks,
        totalResponseTime:
          (previous.totalResponseTime || 0) + group.totalResponseTime,
        minResponseTime:
          group.minResponseTime == null
            ? previous.minResponseTime
            : Math.min(
                previous.minResponseTime ?? Infinity,
                group.minResponseTime,
              ),
        maxResponseTime:
          group.maxResponseTime == null
            ? previous.maxResponseTime
            : Math.max(previous.maxResponseTime ?? 0, group.maxResponseTime),
        downtimeSeconds:
          (previous.downtimeSeconds || 0) + group.downtimeSeconds,
        downtimeKind: "estimated",
        updatedAt: now,
      };
      tx.set(ref, updated);
      tx.set(privateBucketRefs[index], updated);
    }
    tx.set(
      stateRef,
      {
        lastCheckedAt: lastCheck.data().checkedAt,
        lastCheckId: lastCheck.id,
        lockOwner: FieldValue.delete(),
        lockedUntil: FieldValue.delete(),
        updatedAt: now,
      },
      { merge: true },
    );
  });
  return checks.size;
}

async function releaseState(ref, owner, lastCheckedAt, lastCheckId) {
  await db().runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists || snapshot.data().lockOwner !== owner) return;
    tx.set(
      ref,
      {
        lastCheckedAt: lastCheckedAt || FieldValue.delete(),
        lastCheckId: lastCheckId || FieldValue.delete(),
        lockOwner: FieldValue.delete(),
        lockedUntil: FieldValue.delete(),
        updatedAt: Timestamp.now(),
      },
      { merge: true },
    );
  });
}

export async function processAnalytics(limit = 20) {
  const cursorRef = db().collection("systemState").doc("analyticsCursor");
  const cursor = await cursorRef.get();
  let query = db()
    .collection("monitors")
    .orderBy(FieldPath.documentId())
    .limit(limit);
  if (cursor.data()?.lastMonitorId)
    query = query.startAfter(cursor.data().lastMonitorId);
  let monitors = await query.get();
  if (monitors.empty && cursor.data()?.lastMonitorId) {
    await cursorRef.set(
      { lastMonitorId: null, updatedAt: Timestamp.now() },
      { merge: true },
    );
    monitors = await db()
      .collection("monitors")
      .orderBy(FieldPath.documentId())
      .limit(limit)
      .get();
  }
  const owner = crypto.randomUUID();
  let checksProcessed = 0;
  for (const monitor of monitors.docs) {
    checksProcessed += await aggregateMonitor(monitor, owner);
  }
  if (!monitors.empty) {
    await cursorRef.set(
      { lastMonitorId: monitors.docs.at(-1).id, updatedAt: Timestamp.now() },
      { merge: true },
    );
  }
  return { monitorsScanned: monitors.size, checksProcessed };
}
