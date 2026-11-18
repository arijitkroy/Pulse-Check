import { db } from "../firebase/admin.js";

export async function queueIncidentEvent(tx, userId, incident, eventType) {
  const channelsQuery = db()
    .collection("users")
    .doc(userId)
    .collection("notificationChannels")
    .where("enabled", "==", true);
  const channels = await tx.get(channelsQuery);
  const notificationRef = db()
    .collection("users")
    .doc(userId)
    .collection("notifications")
    .doc(`${incident.id}_${eventType.replace(".", "_")}`);
  const now = new Date();

  tx.set(notificationRef, {
    type: eventType,
    title: incident.title,
    incidentId: incident.id,
    monitorId: incident.monitorId,
    status: incident.status,
    createdAt: now,
  });

  for (const channel of channels.docs) {
    if (!channel.data().events?.includes(eventType)) continue;
    const deliveryId = `${incident.id}_${eventType.replace(".", "_")}_${channel.id}`;
    const delivery = db().collection("notificationDeliveries").doc(deliveryId);
    tx.create(delivery, {
      ownerId: userId,
      channelId: channel.id,
      incidentId: incident.id,
      monitorId: incident.monitorId,
      eventType,
      payload: {
        title: incident.title,
        description: incident.description,
        status: incident.status,
        failureReason: incident.failureReason || null,
        startedAt: incident.startedAt,
        resolvedAt: incident.resolvedAt || null,
      },
      idempotencyKey: deliveryId,
      status: "pending",
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    });
  }
}
